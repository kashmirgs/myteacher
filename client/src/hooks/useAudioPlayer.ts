import { useRef, useCallback } from 'react';

/** PCM s16le audio player using AudioContext with queue-based playback */
export function useAudioPlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const queueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  /** When false, feedChunk() is a no-op.  Prevents residual tts_chunk messages
   *  (still in the WebSocket buffer after barge-in) from restarting playback. */
  const acceptingRef = useRef(false);

  function getContext(): AudioContext {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      // Use the browser's native sample rate (typically 44.1/48 kHz).
      // Audio buffers are created at 24 kHz; the Web Audio API resamples
      // automatically.  Forcing sampleRate:24000 causes silent output on
      // some Safari versions despite the context reporting state=running.
      ctxRef.current = new AudioContext();
      // Create persistent GainNode: source → gain → destination
      const gain = ctxRef.current.createGain();
      gain.connect(ctxRef.current.destination);
      gainRef.current = gain;
    }
    return ctxRef.current;
  }

  function getGain(): GainNode {
    getContext(); // ensure ctx + gain exist
    return gainRef.current!;
  }

  /** Decode base64 PCM s16le mono → AudioBuffer */
  function decodeChunk(base64: string): AudioBuffer {
    const ctx = getContext();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // PCM s16le → float32
    const samples = bytes.length / 2;
    const audioBuffer = ctx.createBuffer(1, samples, 24000);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < samples; i++) {
      const int16 = view.getInt16(i * 2, true); // little-endian
      channel[i] = int16 / 32768;
    }

    return audioBuffer;
  }

  /** Schedule an AudioBuffer for gapless playback */
  function scheduleBuffer(audioBuffer: AudioBuffer) {
    const ctx = getContext();
    const gain = getGain();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gain);

    // Track active sources for stop()
    sourcesRef.current.add(source);
    source.onended = () => {
      sourcesRef.current.delete(source);
    };

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + audioBuffer.duration;
  }

  const feedChunk = useCallback((base64Audio: string) => {
    if (!acceptingRef.current) return;
    try {
      const audioBuffer = decodeChunk(base64Audio);
      queueRef.current.push(audioBuffer);
      scheduleBuffer(audioBuffer);
      isPlayingRef.current = true;
    } catch (err) {
      console.error('[audio] failed to decode chunk:', err);
    }
  }, []);

  const start = useCallback(() => {
    acceptingRef.current = true;
    const ctx = getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    isPlayingRef.current = true;
    nextStartTimeRef.current = 0;
  }, []);

  /** Stop playback with 50ms fade-out to prevent click/pop */
  const stop = useCallback(() => {
    acceptingRef.current = false;
    isPlayingRef.current = false;
    queueRef.current = [];

    const ctx = ctxRef.current;
    const gain = gainRef.current;

    if (ctx && ctx.state !== 'closed' && gain) {
      const now = ctx.currentTime;
      // 50ms linear fade-out
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.05);

      // After fade completes, stop all sources and reset gain
      setTimeout(() => {
        for (const source of sourcesRef.current) {
          try {
            source.stop();
          } catch {
            // already stopped
          }
        }
        sourcesRef.current.clear();
        // Reset gain for next playback cycle
        if (gainRef.current && ctxRef.current && ctxRef.current.state !== 'closed') {
          gainRef.current.gain.setValueAtTime(1, ctxRef.current.currentTime);
        }
        nextStartTimeRef.current = 0;
      }, 60); // slightly longer than fade to ensure completion
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const flush = useCallback(() => {
    // Mark playback as no longer actively receiving chunks.
    // Scheduled buffers will finish playing; isTTSPlaying() falls back to
    // the time-based check for the remaining duration.
    isPlayingRef.current = false;
    queueRef.current = [];
  }, []);

  /** Check if TTS audio is currently playing (scheduled buffers pending) */
  const isTTSPlaying = useCallback((): boolean => {
    // Flag is set immediately on first chunk, before enough audio is scheduled
    // for the time-based check to work. This ensures VAD uses the higher
    // TTS threshold from the very first chunk.
    if (isPlayingRef.current) return true;
    const ctx = ctxRef.current;
    if (!ctx || ctx.state === 'closed') return false;
    return nextStartTimeRef.current > ctx.currentTime + 0.1;
  }, []);

  /** Pre-create and resume AudioContext — call during a user gesture (e.g. mic
   *  button click) so the browser's autoplay policy allows audio playback later
   *  when TTS chunks arrive from a non-gesture context (WebSocket handler). */
  const warmUp = useCallback(() => {
    const ctx = getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
  }, []);

  return { feedChunk, start, stop, flush, isTTSPlaying, warmUp };
}
