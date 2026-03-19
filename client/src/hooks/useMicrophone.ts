import { useRef, useState, useCallback } from "react";
import type { ClientMessage } from "@myteacher/shared";

type SendFn = (msg: ClientMessage) => void;
type SendBinaryFn = (data: Blob | ArrayBuffer) => void;

export function useMicrophone(send: SendFn, sendBinary: SendBinaryFn) {
  const [isOpen, setIsOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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

  /** Open mic + start AudioWorklet PCM pipeline (called once, stays open across cycles) */
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

        // Create AudioContext at default sample rate (avoid starving VAD's AudioContext)
        // Downsampling to 16kHz happens inside the worklet processor
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;

        // Load the PCM worklet processor
        await audioContext.audioWorklet.addModule("/pcm-processor.js");

        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        const workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
          processorOptions: { targetSampleRate: 16000 },
        });
        workletNodeRef.current = workletNode;

        workletNode.port.onmessage = (e: MessageEvent) => {
          if (performance.now() < suppressUntilRef.current) return;
          sendBinary(e.data as ArrayBuffer);
        };

        source.connect(workletNode);
        // Connect through a silent GainNode to keep the audio graph active
        // (Chrome won't call process() unless the node reaches destination)
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        workletNode.connect(silentGain);
        silentGain.connect(audioContext.destination);

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

  /** Stop listening (signal server) but keep mic + AudioWorklet alive */
  const stop = useCallback(() => {
    setIsRecording(false);
    console.log("[mic] stop_listening (reason=user_stop)");
    send({ type: "stop_listening", reason: "user_stop", source: "useMicrophone.stop" });
  }, [send]);

  /** Temporarily suppress outgoing audio chunks (used for barge-in reset). */
  const suppressAudio = useCallback((durationMs: number) => {
    suppressUntilRef.current = performance.now() + durationMs;
  }, []);

  /** Full teardown: release mic, stop AudioWorklet, stop stream tracks */
  const close = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    setIsRecording(false);
    setIsOpen(false);
  }, []);

  return { isOpen, isRecording, start, stop, close, setOnStreamReady, suppressAudio };
}
