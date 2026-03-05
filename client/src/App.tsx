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
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [transcript, setTranscript] = useState("");
  const [aiResponse, setAiResponse] = useState("");

  // Ref to avoid stale closures in VAD callbacks and the message handler
  const sessionStateRef = useRef<SessionState>(sessionState);
  // Ref for synchronous VAD reset from ws.onmessage (avoids React 18 batching)
  const vadResetRef = useRef<() => void>(() => {});
  const lastBargeInAtRef = useRef(0);
  const bargeInCloseGuardMs = 1000;

  const audioPlayer = useAudioPlayer();

  // Request mic permission early so the browser prompt appears on page load
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
        audioPlayer.warmUp();
      })
      .catch(() => {});
  }, [audioPlayer]);

  // Message handler is called synchronously from ws.onmessage via a ref,
  // so every message is processed — no React 18 batching drops.
  const { send, sendBinary, isConnected } = useSocket((msg: ServerMessage) => {
    switch (msg.type) {
      case "board_update":
        setBoardItems(msg.items);
        setRevealedCount(0);
        break;
      case "board_reveal":
        setRevealedCount(msg.index + 1);
        break;
      case "state_change":
        setSessionState(msg.state);
        sessionStateRef.current = msg.state;
        if (msg.state === "speaking") {
          audioPlayer.start();
          vadResetRef.current();
        }
        break;
      case "transcript":
        if (msg.isFinal && sessionStateRef.current === "processing") {
          setAiResponse(msg.text);
        } else {
          setTranscript(msg.text);
        }
        break;
      case "tts_start":
        audioPlayer.start();
        break;
      case "tts_chunk":
        audioPlayer.feedChunk(msg.audio);
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

  const handleSpeechStart = useCallback(() => {
    if (audioPlayer.isTTSPlaying()) {
      console.log("[barge-in] speech detected during TTS playback, stopping audio");
      lastBargeInAtRef.current = performance.now();
      audioPlayer.stop();
      suppressAudio(150);
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
      // Full shutdown: VAD + mic
      vadDetach();
      close();
      audioPlayer.stop();
    } else {
      // Warm up AudioContext during this user gesture so the browser's
      // autoplay policy allows playback later when TTS chunks arrive.
      audioPlayer.warmUp();
      start();
    }
  }, [isOpen, start, close, vadDetach, audioPlayer]);

  const handleGenerateLesson = useCallback((topic: string) => {
    send({ type: "generate_lesson", topic });
  }, [send]);

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

  return (
    <div className="app">
      <header className="app-header">
        <h1>MyTeacher</h1>
      </header>
      <main className="app-main">
        <Whiteboard items={boardItems} revealedCount={revealedCount} onAnnotationClick={handleAnnotationClick} />
      </main>
      <aside className="app-sidebar">
        <Controls
          isConnected={isConnected}
          sessionState={sessionState}
          isOpen={isOpen}
          onMicToggle={handleMicToggle}
          onGenerateLesson={handleGenerateLesson}
          transcript={transcript}
          aiResponse={aiResponse}
        />
      </aside>
    </div>
  );
}
