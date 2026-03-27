import { useState, useEffect, useCallback, useRef } from "react";
import type { BoardItem, SessionState, ServerMessage } from "@myteacher/shared";
import { useSocket } from "./hooks/useSocket";
import { useMicrophone } from "./hooks/useMicrophone";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useVAD } from "./hooks/useVAD";
import { Whiteboard } from "./components/Whiteboard";
import { Controls } from "./components/Controls";

export function App() {
  const [boardItems, setBoardItems] = useState<BoardItem[]>([]);
  const [revealedCount, setRevealedCount] = useState(0);
  const [drawingSteps, setDrawingSteps] = useState<Record<number, number>>({});
  const [qaBoardItems, setQaBoardItems] = useState<BoardItem[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [transcript, setTranscript] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [debugMode, setDebugMode] = useState(false);

  // Ref to avoid stale closures in VAD callbacks and the message handler
  const sessionStateRef = useRef<SessionState>(sessionState);
  const boardItemsRef = useRef<BoardItem[]>(boardItems);
  // Ref for synchronous VAD reset from ws.onmessage (avoids React 18 batching)
  const vadResetRef = useRef<() => void>(() => {});
  const lastBargeInAtRef = useRef(0);
  const bargeInCloseGuardMs = 1000;
  const speakingEnteredAtRef = useRef(0);
  const bargeInGraceMs = 500;

  const audioPlayer = useAudioPlayer();

  // Request mic permission early so the browser prompt appears on page load
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      })
      .catch(() => {});
  }, []);

  // Safari requires AudioContext to be created/resumed inside a user gesture.
  // Unlock once on first interaction (click/tap/keydown).
  useEffect(() => {
    const unlock = () => {
      console.debug("[audio] user gesture detected, unlocking audio");
      void audioPlayer.warmUp();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchend", unlock);
      window.removeEventListener("keydown", unlock);
    };

    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("touchend", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("touchend", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [audioPlayer]);

  // Safari can suspend audio when the tab loses focus.
  // Re-warm on visibility to re-unlock output before TTS resumes.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void audioPlayer.warmUp();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [audioPlayer]);

  // Message handler is called synchronously from ws.onmessage via a ref,
  // so every message is processed — no React 18 batching drops.
  const { send, sendBinary, isConnected } = useSocket((msg: ServerMessage) => {
    switch (msg.type) {
      case "board_update":
        setBoardItems(msg.items);
        boardItemsRef.current = msg.items;
        setRevealedCount(0);
        setDrawingSteps({});
        setQaBoardItems([]); // Clear QA overlay when new lesson starts
        break;
      case "qa_board_update":
        console.log("[qa_board_update] items:", JSON.stringify(msg.items, null, 2));
        setQaBoardItems(msg.items);
        break;
      case "qa_board_clear":
        setQaBoardItems([]);
        break;
      case "board_reveal": {
        setRevealedCount(msg.index + 1);
        // If the revealed item is a drawing, auto-activate step 0
        const revealedItem = boardItemsRef.current[msg.index];
        if (revealedItem?.type === "drawing") {
          setDrawingSteps(prev => ({ ...prev, [msg.index]: 1 }));
        }
        break;
      }
      case "drawing_step":
        setDrawingSteps(prev => ({ ...prev, [msg.itemIndex]: msg.stepIndex + 1 }));
        break;
      case "state_change":
        setSessionState(msg.state);
        sessionStateRef.current = msg.state;
        // ⚠️ AUDIO PIPELINE — start() must be skipped when already playing.
        // During lesson resume after Q&A, server sends a second state_change:speaking
        // while Q&A audio tail is still draining. Calling start() here would invoke
        // gain.cancelScheduledValues() which kills Safari audio output.
        // VAD reset and grace period must still run in all cases.
        if (msg.state === "speaking") {
          if (!audioPlayer.isTTSPlaying()) {
            void audioPlayer.start();
          }
          vadResetRef.current();
          speakingEnteredAtRef.current = performance.now();
        }
        break;
      case "transcript":
        if (sessionStateRef.current === "processing" || sessionStateRef.current === "speaking") {
          setAiResponse(msg.text);
        } else {
          setTranscript(msg.text);
        }
        break;
      // ⚠️ AUDIO PIPELINE — tts_start is only sent for normal Q&A responses.
      // Lesson resume (resumeLesson) deliberately skips tts_start to avoid
      // flush()/start() which disrupts the audio pipeline mid-playback.
      case "tts_start":
        void audioPlayer.start();
        break;
      case "tts_chunk":
        void audioPlayer.feedChunk(msg.audio);
        break;
      case "tts_end":
        audioPlayer.flush();
        suppressAudio(300);
        break;
      case "error":
        console.error("[server]", msg.message);
        break;
    }
  });

  const { isOpen, isRecording, start, stop, close, setOnStreamReady, suppressAudio } = useMicrophone(send, sendBinary);

  // Reset session state when connection drops (e.g. server restart)
  useEffect(() => {
    if (!isConnected) {
      setSessionState("idle");
      sessionStateRef.current = "idle";
    }
  }, [isConnected]);

  const handleSpeechStart = useCallback(() => {
    // ⚠️ AUDIO PIPELINE — Grace period (500ms) prevents echo-triggered
    // false barge-ins at TTS start. The speaker's own audio feeds back
    // through the mic before echo suppression kicks in.
    if (audioPlayer.isTTSPlaying()) {
      if (performance.now() - speakingEnteredAtRef.current < bargeInGraceMs) {
        return; // Suppress echo-triggered false barge-in
      }
      console.log("[barge-in] speech detected during TTS playback, stopping audio");
      lastBargeInAtRef.current = performance.now();
      audioPlayer.stop();
      suppressAudio(50);
      console.log("[barge-in] sending message to server");
      send({ type: "barge_in" });
    }
  }, [audioPlayer, send, suppressAudio]);

  const handleSilenceTimeout = useCallback(() => {
    // No-op for now — Deepgram server-side endpointing is sufficient
  }, []);

  const {
    attach: vadAttach,
    startPolling: vadStartPolling,
    detach: vadDetach,
    resetSpeechState: vadResetSpeechState,
  } = useVAD({
    onSpeechStart: handleSpeechStart,
    onSilenceTimeout: handleSilenceTimeout,
    isTTSPlaying: audioPlayer.isTTSPlaying,
  });

  // Wire VAD to mic stream once available
  useEffect(() => {
    setOnStreamReady((stream: MediaStream) => {
      vadAttach(stream);
      vadStartPolling();
    });
  }, [setOnStreamReady, vadAttach, vadStartPolling]);

  // Wire vadResetRef so the synchronous ws.onmessage handler can reset
  // VAD state immediately (bypassing React 18 batching).
  vadResetRef.current = vadResetSpeechState;

  const handleMicToggle = useCallback(() => {
    if (isOpen) {
      const now = performance.now();
      if (now - lastBargeInAtRef.current < bargeInCloseGuardMs) {
        console.log("[mic] close ignored (recent barge_in)");
        return;
      }
      // Shutdown mic + VAD only — do NOT stop audioPlayer so TTS/lesson continues
      vadDetach();
      close();
    } else {
      // Warm up AudioContext during this user gesture so the browser's
      // autoplay policy allows playback later when TTS chunks arrive.
      if (audioPlayer.isTTSPlaying()) {
        // Reset grace period so VAD doesn't immediately trigger a false
        // barge-in from TTS audio bleed through the mic.
        speakingEnteredAtRef.current = performance.now();
      } else {
        void audioPlayer.warmUp();
      }
      start();
    }
  }, [isOpen, start, close, vadDetach, audioPlayer]);

  const handleGenerateLesson = useCallback(
    (topic: string) => {
      void audioPlayer.warmUp();
      send({ type: "generate_lesson", topic });
    },
    [send, audioPlayer],
  );

  const handleStartPresetLesson = useCallback(
    (topicId: string) => {
      void audioPlayer.warmUp();
      send({ type: "start_preset_lesson", topicId });
    },
    [send, audioPlayer],
  );

  const handleAnnotationClick = useCallback(
    (index: number) => {
      send({
        type: "annotation_click",
        index,
        question: "Bu ne demek?",
      });
    },
    [send],
  );

  const handleOverlayDismiss = useCallback(() => {
    send({ type: "qa_overlay_dismiss" });
  }, [send]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>MyTeacher</h1>
      </header>
      <main className="app-main">
        <Whiteboard items={boardItems} revealedCount={revealedCount} drawingSteps={drawingSteps} onAnnotationClick={handleAnnotationClick} overlayItems={qaBoardItems} onOverlayDismiss={handleOverlayDismiss} />
      </main>
      <aside className="app-sidebar">
        <Controls
          isConnected={isConnected}
          sessionState={sessionState}
          isOpen={isOpen}
          onMicToggle={handleMicToggle}
          onGenerateLesson={handleGenerateLesson}
          onStartPresetLesson={handleStartPresetLesson}
          transcript={transcript}
          aiResponse={aiResponse}
          debugMode={debugMode}
          onDebugToggle={setDebugMode}
        />
      </aside>
    </div>
  );
}
