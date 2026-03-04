import { useRef, useCallback } from 'react';

// VAD configuration
const VAD_THRESHOLD = 0.012; // Normal (TTS not playing)
const VAD_INTERRUPT_THRESHOLD = 0.015; // Higher during TTS to guard against AEC residual
const VAD_WINDOW_SIZE = 8; // Sliding window: 8 frames × 50ms = 400ms
const VAD_TRIGGER_COUNT_NORMAL = 3; // 3/8 frames above threshold → speech
const VAD_TRIGGER_COUNT_TTS = 4; // 4/8 frames during TTS (extra guard for AEC residual)
const SILENCE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 50;

interface UseVADOptions {
  onSpeechStart: () => void;
  onSilenceTimeout: () => void;
  isTTSPlaying: () => boolean;
}

/**
 * Voice Activity Detection using AnalyserNode + RMS energy + sliding window.
 * Independent hook — uses same MediaStream as useMicrophone but separate AudioContext.
 */
export function useVAD(options: UseVADOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadActiveRef = useRef(false);
  const windowRef = useRef<boolean[]>(new Array(VAD_WINDOW_SIZE).fill(false));
  const windowIdxRef = useRef(0);
  const logCounterRef = useRef(0);

  function pollVAD() {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(data);

    // RMS energy
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);

    const ttsPlaying = optionsRef.current.isTTSPlaying();
    const threshold = ttsPlaying ? VAD_INTERRUPT_THRESHOLD : VAD_THRESHOLD;
    const isAbove = rms > threshold;

    // Log every ~1 second (20 × 50ms)
    if (++logCounterRef.current % 20 === 0) {
      console.log(
        '[VAD] RMS:',
        rms.toFixed(5),
        'threshold:',
        threshold,
        ttsPlaying ? '(TTS)' : '',
        'above:',
        isAbove,
      );
    }

    // Sliding window: record this frame
    windowRef.current[windowIdxRef.current] = isAbove;
    windowIdxRef.current = (windowIdxRef.current + 1) % VAD_WINDOW_SIZE;
    const aboveCount = windowRef.current.filter(Boolean).length;
    const neededFrames = ttsPlaying ? VAD_TRIGGER_COUNT_TTS : VAD_TRIGGER_COUNT_NORMAL;

    if (isAbove) {
      // Clear silence timer on any speech energy
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }

      // Trigger speech when enough frames in window are above threshold
      if (!vadActiveRef.current && aboveCount >= neededFrames) {
        vadActiveRef.current = true;
        optionsRef.current.onSpeechStart();
      }
    } else {
      if (vadActiveRef.current) {
        // Start silence timer
        if (!silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            vadActiveRef.current = false;
            silenceTimerRef.current = null;
            optionsRef.current.onSilenceTimeout();
          }, SILENCE_TIMEOUT_MS);
        }
      }
    }
  }

  /** Connect VAD to a MediaStream */
  const attach = useCallback((stream: MediaStream) => {
    // Already attached — skip to prevent re-creating AnalyserNode on every render
    if (analyserRef.current) return;

    // Create separate AudioContext at native sample rate (not 24kHz TTS context)
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    sourceRef.current = source;
    analyserRef.current = analyser;

    console.log('[VAD] attached, sampleRate:', ctx.sampleRate);
  }, []);

  /** Start polling for voice activity */
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(pollVAD, POLL_INTERVAL_MS);
    console.log('[VAD] polling started');
  }, []);

  /** Stop polling */
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadActiveRef.current = false;
    windowRef.current.fill(false);
    windowIdxRef.current = 0;
    logCounterRef.current = 0;
    console.log('[VAD] polling stopped');
  }, []);

  /** Full teardown: disconnect audio nodes and close context */
  const detach = useCallback(() => {
    stopPolling();

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    analyserRef.current = null;

    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    console.log('[VAD] detached');
  }, [stopPolling]);

  /** Reset speech detection state without stopping polling.
   *  Call when entering 'speaking' state so the next speech triggers a fresh
   *  onSpeechStart — otherwise vadActiveRef stays true from the user's earlier
   *  utterance and the false→true edge never fires for barge-in. */
  const resetSpeechState = useCallback(() => {
    vadActiveRef.current = false;
    windowRef.current.fill(false);
    windowIdxRef.current = 0;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  return { attach, startPolling, stopPolling, detach, resetSpeechState };
}
