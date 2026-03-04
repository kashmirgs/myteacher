import { useRef, useState, useCallback } from "react";
import type { ClientMessage } from "@myteacher/shared";

type SendFn = (msg: ClientMessage) => void;
type SendBinaryFn = (data: Blob | ArrayBuffer) => void;

export function useMicrophone(send: SendFn, sendBinary: SendBinaryFn) {
  const [isOpen, setIsOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onStreamReadyRef = useRef<((stream: MediaStream) => void) | null>(null);
  const suppressUntilRef = useRef(0);

  /** Register callback to receive the MediaStream once acquired (for VAD) */
  const setOnStreamReady = useCallback((cb: (stream: MediaStream) => void) => {
    onStreamReadyRef.current = cb;
    // If stream already exists, call immediately
    if (streamRef.current) {
      cb(streamRef.current);
    }
  }, []);

  /** Open mic + start MediaRecorder (called once, stays open across cycles) */
  const start = useCallback(async () => {
    try {
      // Only acquire stream once
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;
        setIsOpen(true);

        // Start MediaRecorder once — it stays running across cycles
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (performance.now() < suppressUntilRef.current) return;
          if (event.data.size > 0) {
            sendBinary(event.data);
          }
        };

        recorder.start(250); // Send chunks every 250ms

        // Notify VAD about the stream
        if (onStreamReadyRef.current) {
          onStreamReadyRef.current(stream);
        }
      }

      setIsRecording(true);
      send({ type: "start_listening" });
    } catch (err) {
      console.error("[mic] getUserMedia failed:", err);
    }
  }, [send, sendBinary]);

  /** Stop listening (signal server) but keep mic + MediaRecorder alive */
  const stop = useCallback(() => {
    setIsRecording(false);
    console.log("[mic] stop_listening (reason=user_stop)");
    send({ type: "stop_listening", reason: "user_stop", source: "useMicrophone.stop" });
  }, [send]);

  /** Temporarily suppress outgoing audio chunks (used for barge-in reset). */
  const suppressAudio = useCallback((durationMs: number) => {
    suppressUntilRef.current = performance.now() + durationMs;
  }, []);

  /** Full teardown: release mic, stop MediaRecorder, stop stream tracks */
  const close = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setIsRecording(false);
    setIsOpen(false);
  }, [send]);

  return { isOpen, isRecording, start, stop, close, setOnStreamReady, suppressAudio };
}
