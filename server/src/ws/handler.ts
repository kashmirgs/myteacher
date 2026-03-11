import type { WebSocket, RawData } from "ws";
import type { ClientMessage, ServerMessage, BoardItem } from "@myteacher/shared";
import { SessionStateMachine } from "../session/state-machine.js";
import { createSTTService } from "../services/deepgram.js";
import { createLLMService, type LLMStreamHandle, type LessonBoardItem } from "../services/claude.js";
import { createTTSService } from "../services/cartesia.js";
import { ConversationHistory } from "../services/conversation.js";
import { getTopicById } from "../db/repository.js";

/** Detect clause boundary: `.` `?` `!` followed by space or end-of-string, min 10 chars */
function extractClause(buffer: string): { clause: string; remaining: string } | null {
  // Look for sentence-ending punctuation followed by space or end-of-string
  const match = buffer.match(/^(.{10,}?[.?!])(?:\s|$)/);
  if (match) {
    const clause = match[1];
    const remaining = buffer.slice(match[0].length);
    return { clause, remaining };
  }
  return null;
}

const RESUME_PATTERNS =
  /^(devam|devam\s+et|derse\s+devam|derse\s+devam\s+et|devam\s+edelim|sürdür|geç|tamam\s+devam|evet\s+devam)\b/i;

function isResumeCommand(text: string): boolean {
  // Strip punctuation and normalize whitespace for robust matching
  const cleaned = text.trim().replace(/[.,!?;:]+$/g, "").trim();
  return RESUME_PATTERNS.test(cleaned);
}

export function handleConnection(ws: WebSocket): void {
  let boardItems: BoardItem[] = [];
  let pendingAudio: Buffer[] = [];
  let currentLLMHandle: LLMStreamHandle | null = null;
  let llmGeneration = 0;
  let sttGeneration = 0;
  let sttActive = false;
  let sttRestartTimer: NodeJS.Timeout | null = null;
  let revealTimers: NodeJS.Timeout[] = [];
  const sttRestartDelayMs = process.env.NODE_ENV === "test" ? 0 : 350;
  const bargeInSuppressMs = process.env.NODE_ENV === "test" ? 0 : 400;
  const ttsEndSuppressMs = process.env.NODE_ENV === "test" ? 0 : 500;
  const ttsEndSTTDelayMs = process.env.NODE_ENV === "test" ? 0 : 150;
  let suppressTranscriptsUntil = 0;
  const stopAfterBargeInMs = 1000;
  let lastBargeInAt = 0;

  // Lesson narration state – enables resume after barge-in Q&A
  let lessonSpeeches: string[] = [];
  let isLessonNarrating = false;
  let lastRevealedIdx = 0;
  let lastQAResponseLength = 0;

  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const session = new SessionStateMachine(send);
  const stt = createSTTService();
  const llm = createLLMService();
  const tts = createTTSService();
  const history = new ConversationHistory();

  /** Start a speech response cycle: streaming LLM → clause-based TTS → back to listening */
  function handleFinalTranscript(text: string) {
    if (session.getState() !== "listening") return;

    // Ders anlatımı sırasında "devam et" benzeri ifadeler → LLM'i atla, direkt resume
    if (isLessonNarrating) {
      const resume = isResumeCommand(text);
      console.log(`[handler] transcript during lesson: "${text}", isResumeCommand=${resume}, lastRevealedIdx=${lastRevealedIdx}`);
      if (resume) {
        if (!session.transition("processing")) return;
        if (!session.transition("speaking")) return;
        // Client audio player was stopped by barge-in, so send tts_start
        // (unlike auto-resume from Q&A onEnd where client is still playing)
        send({ type: "tts_start" });
        resumeLesson(lastRevealedIdx + 1);
        return;
      }
    }

    const t0 = performance.now();
    let t1 = 0,
      t2 = 0,
      t3 = 0,
      t4 = 0;
    let firstToken = true;
    let firstClause = true;
    let firstAudioChunk = true;
    let firstTtsChunkSent = true;

    if (!session.transition("processing")) return;

    // ⚠️ AUDIO PIPELINE — Generation counters (llmGeneration, sttGeneration)
    // are the primary mechanism to invalidate stale async callbacks.
    // Every abort/restart increments the counter; callbacks compare against
    // their captured value and become no-ops if mismatched.
    // Without this, audio from old streams bleeds into new sessions.
    const gen = ++llmGeneration;

    let buffer = "";

    // Pre-open Cartesia WS immediately (in parallel with LLM streaming)
    const ttsHandle = tts.openStream({
      onStart: () => {},
      onChunk: (audio) => {
        if (gen !== llmGeneration) return;
        if (firstAudioChunk) {
          t3 = performance.now() - t0;
          firstAudioChunk = false;
        }
        send({ type: "tts_chunk", audio });
        if (firstTtsChunkSent) {
          t4 = performance.now() - t0;
          firstTtsChunkSent = false;
        }
      },
      // ⚠️ AUDIO PIPELINE — When isLessonNarrating, onEnd triggers resumeLesson()
      // instead of sending tts_end. This keeps the client audio player in playing
      // mode so resumed lesson chunks append seamlessly. The state_change:speaking
      // sent here is for VAD reset + grace period, NOT for audioPlayer.start().
      onEnd: () => {
        if (session.getState() !== "speaking") return;
        if (isLessonNarrating) {
          console.log(`[handler] Q&A TTS ended, resuming lesson from idx ${lastRevealedIdx + 1}`);
          send({ type: "state_change", state: "speaking" });
          resumeLesson(lastRevealedIdx + 1);
          return;
        }
        send({ type: "tts_end" });
        session.transition("listening");
        suppressTranscriptsUntil = performance.now() + ttsEndSuppressMs;
        scheduleSTTStart(ttsEndSTTDelayMs);
        pendingAudio.length = 0; // Discard echo-contaminated audio
      },
    });

    // When a lesson is being narrated, tell the LLM to keep its answer
    // short — the system will automatically resume the lesson afterwards.
    if (isLessonNarrating) {
      history.addUserMessage(
        `[Sistem: Ders anlatımı devam ediyor. Çok kısa cevap ver (1 cümle). Dersi sen anlatma, sistem otomatik devam edecek.]\n${text}`,
      );
    } else {
      history.addUserMessage(text);
    }

    currentLLMHandle = llm.streamSpeechResponse(text, history, {
      onToken(delta, snapshot) {
        if (gen !== llmGeneration) return;
        if (firstToken) {
          t1 = performance.now() - t0;
          firstToken = false;
        }

        buffer += delta;

        // Send partial transcript to client
        send({ type: "transcript", text: snapshot, isFinal: false });

        // Check for clause boundaries
        let extracted = extractClause(buffer);
        while (extracted) {
          const { clause, remaining } = extracted;
          buffer = remaining;

          if (firstClause) {
            t2 = performance.now() - t0;
            firstClause = false;
            if (!session.transition("speaking")) return;
          }

          ttsHandle.feed(clause, false);
          extracted = extractClause(buffer);
        }
      },

      onDone(fullText) {
        if (gen !== llmGeneration) return;
        if (isLessonNarrating) lastQAResponseLength = fullText.length;
        history.addAssistantMessage(fullText);
        send({ type: "transcript", text: fullText, isFinal: true });

        if (firstClause) {
          // No clause boundary was ever detected — treat full text as single clause
          t2 = performance.now() - t0;
          if (!session.transition("speaking")) return;
        }

        // Flush remaining buffer as final clause
        const remaining = firstClause ? fullText : buffer.trim();
        ttsHandle.feed(remaining || "", true);

        currentLLMHandle = null;
        console.log(
          `[latency] T1=${t1.toFixed(0)}ms T2=${t2.toFixed(0)}ms T3=${t3.toFixed(0)}ms T4=${t4.toFixed(0)}ms`,
        );
      },

      onError(err) {
        if (gen !== llmGeneration) return;
        currentLLMHandle = null;
        tts.stop(); // Clean up the pre-opened WS
        send({
          type: "error",
          message: err instanceof Error ? err.message : "LLM error",
        });
        session.transition("idle");
      },
    });
  }

  /** Start STT with proper transcript handling */
  function startSTT() {
    if (sttActive) return;
    sttActive = true;
    const gen = ++sttGeneration;
    stt.start({
      onTranscript: (text, isFinal) => {
        // Drop any late transcripts coming from a previous Deepgram session.
        // This is critical for barge-in/stop flows where `stt.stop()` may cause
        // Deepgram to flush a final transcript after we've already restarted.
        if (gen !== sttGeneration) return;
        if (session.getState() !== "listening") return;
        if (performance.now() < suppressTranscriptsUntil) return;
        send({ type: "transcript", text, isFinal });
        if (isFinal) {
          stopSTT();
          handleFinalTranscript(text);
        }
      },
    });
  }

  function stopSTT() {
    if (!sttActive) return;
    sttActive = false;
    // Invalidate current generation immediately so any pending async callbacks
    // (including stop-flush finals) become no-ops.
    sttGeneration++;
    stt.stop();
  }

  function scheduleSTTStart(delayMs = sttRestartDelayMs) {
    if (sttRestartTimer) clearTimeout(sttRestartTimer);
    if (delayMs <= 0) {
      startSTT();
      return;
    }
    sttRestartTimer = setTimeout(() => {
      sttRestartTimer = null;
      startSTT();
    }, delayMs);
  }

  // ⚠️ AUDIO PIPELINE — resumeLesson() must NOT send tts_start or tts_end
  // before feeding chunks. The client audio player is still in "playing" mode
  // from the Q&A response. Sending tts_start would trigger start() →
  // cancelScheduledValues() → Safari audio death. Sending tts_end before
  // resume chunks would trigger flush() → isPlayingRef=false → next
  // state_change:speaking would call start() (same Safari death).
  // The flow is: Q&A onEnd → state_change:speaking → tts_chunks directly.
  /** Resume lesson narration from a given speech index after a barge-in Q&A. */
  function resumeLesson(fromIdx: number) {
    const remaining = lessonSpeeches.slice(fromIdx);
    if (remaining.every((s) => !s)) {
      isLessonNarrating = false;
      session.transition("listening");
      suppressTranscriptsUntil = performance.now() + ttsEndSuppressMs;
      scheduleSTTStart(ttsEndSTTDelayMs);
      pendingAudio.length = 0;
      return;
    }

    const remainingNonEmpty = remaining.filter(Boolean);
    console.log(
      `[handler] resuming lesson from index ${fromIdx}/${lessonSpeeches.length}, ${remainingNonEmpty.length} non-empty speeches remaining`,
    );
    const gen = ++llmGeneration;

    // No tts_start — client audio player is still in playing mode from the Q&A response.
    // This avoids flush()/start() which could disrupt the audio pipeline.

    let firstResumeChunk = true;
    const ttsHandle = tts.openStream({
      onStart: () => {},
      onChunk: (audio) => {
        if (gen !== llmGeneration) return;
        // ⚠️ AUDIO PIPELINE — Re-send state_change:speaking on first chunk so the
        // client resets its barge-in grace period (500ms) to align with when audio
        // actually starts playing. Without this, the grace period (set when Q&A
        // onEnd fires) expires before resume audio reaches the speakers, and echo
        // from the resume audio triggers a false barge-in → audio death.
        if (firstResumeChunk) {
          firstResumeChunk = false;
          send({ type: "state_change", state: "speaking" });
        }
        send({ type: "tts_chunk", audio });
      },
      onEnd: () => {
        if (gen !== llmGeneration) return;
        if (session.getState() !== "speaking") return;
        console.log(`[handler] resumed lesson TTS ended, lesson narration complete`);
        isLessonNarrating = false;
        send({ type: "tts_end" });
        session.transition("listening");
        suppressTranscriptsUntil = performance.now() + ttsEndSuppressMs;
        scheduleSTTStart(ttsEndSTTDelayMs);
        pendingAudio.length = 0;
      },
    });

    send({ type: "transcript", text: remainingNonEmpty.join(" "), isFinal: true });

    // Transition prefix prepended to the first speech so Cartesia produces
    // a natural pause. Long Q&A → spoken phrase; short Q&A → brief "Peki."
    // Feeding separately can cause Cartesia to end the stream early, so we
    // prepend to the first speech text instead.
    const isTest = process.env.NODE_ENV === "test";
    const transitionPrefix = isTest ? "" : lastQAResponseLength > 150 ? "Şimdi derse devam edelim. " : ". ";
    lastQAResponseLength = 0;

    const MS_PER_CHAR = 65;
    let cumulativeDelay = transitionPrefix.length * MS_PER_CHAR;
    let isFirstSpeech = true;

    for (let i = fromIdx; i < lessonSpeeches.length; i++) {
      const speech = lessonSpeeches[i];
      if (!speech) continue;

      if (cumulativeDelay > 0) {
        const delay = cumulativeDelay;
        revealTimers.push(
          setTimeout(() => {
            if (gen !== llmGeneration) return;
            lastRevealedIdx = i;
            console.log(`[handler] board_reveal index=${i} (resumed, delayed)`);
            send({ type: "board_reveal", index: i });
          }, delay),
        );
      } else {
        lastRevealedIdx = i;
        console.log(`[handler] board_reveal index=${i} (resumed, immediate)`);
        send({ type: "board_reveal", index: i });
      }

      const feedText = isFirstSpeech ? transitionPrefix + speech + " " : speech + " ";
      isFirstSpeech = false;
      const isLast = lessonSpeeches.slice(i + 1).every((s) => !s) || i === lessonSpeeches.length - 1;
      ttsHandle.feed(feedText, isLast);
      cumulativeDelay += speech.length * MS_PER_CHAR;
    }
  }

  /** Start lesson narration from pre-built LessonBoardItems (used by both generate_lesson and start_preset_lesson) */
  function startNarration(lessonItems: LessonBoardItem[]) {
    // Extract speeches, store clean board items
    const speeches = lessonItems.map((it) => {
      const speech = (it as { speech?: string }).speech;
      if (speech) return speech;
      if ("text" in it && typeof it.text === "string") return it.text;
      return "";
    });
    boardItems = lessonItems.map((it) => {
      const { speech, ...rest } = it as any;
      return rest as BoardItem;
    });

    lessonSpeeches = speeches;
    isLessonNarrating = true;
    lastRevealedIdx = 0;

    history.addBoardEvent(boardItems);
    send({ type: "board_update", items: boardItems });
    send({ type: "board_reveal", index: 0 }); // title immediately

    const gen = ++llmGeneration;

    // Open TTS stream
    let firstLessonChunk = true;
    const ttsHandle = tts.openStream({
      onStart: () => {},
      onChunk: (audio) => {
        if (gen !== llmGeneration) return;
        if (firstLessonChunk) {
          console.log("[handler] first tts_chunk sent to client");
          firstLessonChunk = false;
        }
        send({ type: "tts_chunk", audio });
      },
      onEnd: () => {
        if (gen !== llmGeneration) return;
        if (session.getState() !== "speaking") return;
        isLessonNarrating = false;
        send({ type: "tts_end" });
        session.transition("listening");
        suppressTranscriptsUntil = performance.now() + ttsEndSuppressMs;
        scheduleSTTStart(ttsEndSTTDelayMs);
        pendingAudio.length = 0;
      },
    });

    if (!session.transition("speaking")) return;

    // Send full transcript
    const fullSpeech = speeches.filter(Boolean).join(" ");
    send({ type: "transcript", text: fullSpeech, isFinal: true });

    // Per-item TTS feeding + setTimeout reveal pacing
    const MS_PER_CHAR = 65;
    let cumulativeDelay = 0;
    const feedableSpeeches = speeches.filter(Boolean);
    console.log(
      `[handler] lesson speeches: ${feedableSpeeches.length}/${speeches.length} non-empty, total chars=${feedableSpeeches.join(" ").length}`,
    );

    for (let i = 0; i < lessonItems.length; i++) {
      const speech = speeches[i];
      if (!speech) continue;

      if (i > 0) {
        const delay = cumulativeDelay;
        revealTimers.push(
          setTimeout(() => {
            if (gen !== llmGeneration) return;
            lastRevealedIdx = i;
            send({ type: "board_reveal", index: i });
          }, delay),
        );
      }

      const isLast = speeches.slice(i + 1).every((s) => !s) || i === lessonItems.length - 1;
      ttsHandle.feed(speech + " ", isLast);
      cumulativeDelay += speech.length * MS_PER_CHAR;
    }

    currentLLMHandle = null; // no LLM stream to track
  }

  ws.on("message", async (raw: RawData, isBinary: boolean) => {
    // Binary frame = audio data from microphone
    if (isBinary) {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      stt.saveHeader(buffer); // Always capture WebM header regardless of state
      const state = session.getState();
      if (state === "listening") {
        stt.feedAudio(buffer);
      } else if (state === "speaking") {
        pendingAudio.push(buffer);
      }
      return;
    }

    // Text frame = JSON control message
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send({ type: "error", message: "invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "start_listening": {
        console.log("[handler] start_listening received");
        if (session.getState() !== "idle") {
          console.log(`[handler] start_listening ignored (state=${session.getState()})`);
          break;
        }
        suppressTranscriptsUntil = 0;
        if (!session.transition("listening")) break;
        startSTT();
        break;
      }

      case "stop_listening": {
        console.log(
          "[handler] stop_listening received",
          "reason" in msg && msg.reason ? `reason=${msg.reason}` : "",
          "source" in msg && msg.source ? `source=${msg.source}` : "",
        );
        if ("reason" in msg && msg.reason === "mic_close") {
          console.log("[handler] stop_listening ignored (reason=mic_close)");
          break;
        }
        const now = performance.now();
        if (lastBargeInAt > 0 && now - lastBargeInAt < stopAfterBargeInMs) {
          console.log("[handler] stop_listening ignored (recent barge_in)");
          break;
        }
        llmGeneration++;
        currentLLMHandle?.abort();
        currentLLMHandle = null;
        tts.stop();
        revealTimers.forEach((t) => clearTimeout(t));
        revealTimers = [];
        pendingAudio.length = 0;
        if (sttRestartTimer) {
          clearTimeout(sttRestartTimer);
          sttRestartTimer = null;
        }
        stopSTT();
        isLessonNarrating = false;
        lessonSpeeches = [];
        session.transition("idle");
        break;
      }

      case "audio_chunk": {
        // Legacy base64 path (fallback)
        const buffer = Buffer.from(msg.data, "base64");
        stt.feedAudio(buffer);
        break;
      }

      // ⚠️ AUDIO PIPELINE — barge_in preserves isLessonNarrating flag.
      // This tells the Q&A onEnd callback to call resumeLesson() instead of
      // transitioning to listening. Do NOT reset isLessonNarrating here.
      case "barge_in": {
        const state = session.getState();
        console.log(
          "[handler] barge_in received, state=",
          state,
          "isLessonNarrating=",
          isLessonNarrating,
          "lastRevealedIdx=",
          lastRevealedIdx,
        );
        lastBargeInAt = performance.now();
        if (state === "listening") {
          console.log("[handler] barge_in ignored (already listening)");
          break;
        }
        suppressTranscriptsUntil = performance.now() + bargeInSuppressMs;
        llmGeneration++;
        currentLLMHandle?.abort();
        currentLLMHandle = null;
        tts.stop();
        revealTimers.forEach((t) => clearTimeout(t));
        revealTimers = [];
        if (state === "speaking") {
          stopSTT();
          // Discard audio buffered during TTS — it contains the barge-in
          // speech fragment which Deepgram would treat as a complete utterance.
          // The user's fresh speech will arrive via MediaRecorder after the interrupt.
          pendingAudio.length = 0;
          session.bargeIn(); // speaking → listening
          scheduleSTTStart();
        } else if (state === "processing") {
          if (session.transition("idle") && session.transition("listening")) {
            scheduleSTTStart();
          }
        }
        // If already listening, STT is active and receiving audio — don't restart it.
        // The client sent barge_in because its audio buffer was still draining,
        // but the server already transitioned via onEnd.
        break;
      }

      case "generate_lesson": {
        console.log(`[handler] generate_lesson topic="${msg.topic}"`);
        if (!session.transition("processing")) break;

        let lessonItems: LessonBoardItem[];
        try {
          lessonItems = await llm.generateLesson(msg.topic);
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "lesson generation failed" });
          session.transition("idle");
          break;
        }

        startNarration(lessonItems);
        break;
      }

      case "start_preset_lesson": {
        console.log(`[handler] start_preset_lesson topicId="${msg.topicId}"`);
        if (!session.transition("processing")) break;

        const topic = getTopicById(msg.topicId);
        if (!topic) {
          send({ type: "error", message: "Konu bulunamadı" });
          session.transition("idle");
          break;
        }

        let lessonItems: LessonBoardItem[];
        try {
          lessonItems = JSON.parse(topic.boardItems) as LessonBoardItem[];
        } catch {
          send({ type: "error", message: "Konu verisi bozuk" });
          session.transition("idle");
          break;
        }

        startNarration(lessonItems);
        break;
      }

      case "annotation_click": {
        if (msg.index < 0 || msg.index >= boardItems.length || !Number.isInteger(msg.index)) {
          send({
            type: "error",
            message: `invalid annotation index: ${msg.index}`,
          });
          break;
        }

        try {
          const q = msg.question || "Bu ne demek?";
          const answer = await llm.answerAnnotation(boardItems, msg.index, q, history);
          history.addUserMessage(q);
          history.addAssistantMessage(answer);
          send({ type: "transcript", text: answer, isFinal: true });
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : "annotation error",
          });
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
    llmGeneration++;
    currentLLMHandle?.abort();
    currentLLMHandle = null;
    if (sttRestartTimer) clearTimeout(sttRestartTimer);
    revealTimers.forEach((t) => clearTimeout(t));
    revealTimers = [];
    stopSTT();
    sttGeneration++;
    tts.stop();
    isLessonNarrating = false;
    lessonSpeeches = [];
    session.reset();
  });
}
