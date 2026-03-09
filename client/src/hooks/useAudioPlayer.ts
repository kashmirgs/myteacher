import { useRef, useCallback } from "react";

const AudioContextCtor: typeof AudioContext =
  window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
const SOURCE_SAMPLE_RATE = 24000;

/** PCM s16le audio player using AudioContext with queue-based playback */
export function useAudioPlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  // Safari can report AudioContext=running but still output silence.
  // As a fallback, we route audio to a MediaStream and play it via an
  // HTMLAudioElement to force an output device unlock.
  const mediaDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const mediaElRef = useRef<HTMLAudioElement | null>(null);
  // True => single output route is media element (prevents double output/echo).
  const mediaRouteActiveRef = useRef(false);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const queueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  /** When false, feedChunk() is a no-op.  Prevents residual tts_chunk messages
   *  (still in the WebSocket buffer after barge-in) from restarting playback. */
  const acceptingRef = useRef(false);

  function getContext(): AudioContext {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      // Use the browser's native sample rate (typically 44.1/48 kHz).
      // Audio buffers are created at 24 kHz; the Web Audio API resamples
      // automatically.  Forcing sampleRate:24000 causes silent output on
      // some Safari versions despite the context reporting state=running.
      // ⚠️ Do NOT change to sampleRate:24000 — breaks Safari silently.
      ctxRef.current = new AudioContextCtor();
      // Create persistent GainNode: source → gain → destination
      const gain = ctxRef.current.createGain();
      gainRef.current = gain;
      mediaRouteActiveRef.current = false;
      connectOutputRoute();
    }
    return ctxRef.current;
  }

  function connectOutputRoute() {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    // Important: disconnect first, then connect exactly one route.
    // Keeping both destination + media connected causes audible echo.
    try {
      gain.disconnect();
    } catch {
      // no-op
    }

    if (mediaRouteActiveRef.current && mediaDestRef.current) {
      gain.connect(mediaDestRef.current);
      console.debug('[audio] route=media');
    } else {
      gain.connect(ctx.destination);
      console.debug('[audio] route=destination');
    }
  }

  async function ensureRunning(ctx: AudioContext, reason: string) {
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err) {
        console.warn("[audio] resume failed:", reason, err);
      }
    }
    if (ctx.state !== "running") {
      console.debug("[audio] context not running after resume:", reason, ctx.state);
    }
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
    const input = new Float32Array(samples);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < samples; i++) {
      const int16 = view.getInt16(i * 2, true); // little-endian
      input[i] = int16 / 32768;
    }

    const targetRate = ctx.sampleRate;
    if (targetRate === SOURCE_SAMPLE_RATE) {
      const audioBuffer = ctx.createBuffer(1, samples, targetRate);
      audioBuffer.getChannelData(0).set(input);
      return audioBuffer;
    }

    const ratio = targetRate / SOURCE_SAMPLE_RATE;
    const outputSamples = Math.max(1, Math.round(samples * ratio));
    const audioBuffer = ctx.createBuffer(1, outputSamples, targetRate);
    const channel = audioBuffer.getChannelData(0);

    for (let i = 0; i < outputSamples; i++) {
      const pos = i / ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx] ?? 0;
      const s1 = input[idx + 1] ?? s0;
      channel[i] = s0 + (s1 - s0) * frac;
    }

    return audioBuffer;
  }

  /** Schedule an AudioBuffer for gapless playback */
  async function scheduleBuffer(audioBuffer: AudioBuffer) {
    const ctx = getContext();
    const gain = getGain();
    await ensureRunning(ctx, "schedule");

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

  const feedChunk = useCallback(async (base64Audio: string) => {
    if (!acceptingRef.current) return;
    try {
      if (queueRef.current.length === 0) {
        console.debug("[audio] first chunk received");
      }
      const audioBuffer = decodeChunk(base64Audio);
      if (queueRef.current.length === 0) {
        const data = audioBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const value = Math.abs(data[i]);
          if (value > peak) peak = value;
        }
        console.debug(
          "[audio] decoded chunk duration=",
          audioBuffer.duration.toFixed(3),
          "rate=",
          audioBuffer.sampleRate,
          "peak=",
          peak.toFixed(4),
        );
      }
      queueRef.current.push(audioBuffer);
      await scheduleBuffer(audioBuffer);
      isPlayingRef.current = true;
    } catch (err) {
      console.error("[audio] failed to decode chunk:", err);
    }
  }, []);

  // ⚠️ AUDIO PIPELINE — start() resets GainNode scheduled values.
  // Calling this while audio is still scheduled (isTTSPlaying() === true)
  // corrupts Safari's audio output — gain.cancelScheduledValues() kills
  // scheduled buffers silently. Always guard with isTTSPlaying() check.
  // See: App.tsx state_change handler, resumeLesson() in handler.ts.
  const start = useCallback(async () => {
    acceptingRef.current = true;
    const ctx = getContext();
    const gain = getGain();
    await ensureRunning(ctx, "start");
    console.debug("[audio] start, ctx.state=", ctx.state, "sampleRate=", ctx.sampleRate);
    // Ensure gain is 1 — a previous stop() may have faded it to 0
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(1, ctx.currentTime);
    isPlayingRef.current = true;
    // Only reset schedule time if no audio is still playing — otherwise
    // new chunks should append after existing ones (e.g. lesson resume
    // right after Q&A answer finishes on the server but client is still
    // playing the tail of the answer).
    const now = ctx.currentTime;
    if (nextStartTimeRef.current <= now) {
      nextStartTimeRef.current = 0;
    }
  }, []);

  // ⚠️ AUDIO PIPELINE — 50ms fade + 60ms cleanup are tightly coupled.
  // Changing these values or removing the setTimeout can cause clicks/pops
  // or leave gain stuck at 0 for the next playback cycle.
  /** Stop playback with 50ms fade-out to prevent click/pop */
  const stop = useCallback(() => {
    acceptingRef.current = false;
    isPlayingRef.current = false;
    queueRef.current = [];

    const ctx = ctxRef.current;
    const gain = gainRef.current;

    if (ctx && ctx.state !== "closed" && gain) {
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
        if (gainRef.current && ctxRef.current && ctxRef.current.state !== "closed") {
          gainRef.current.gain.setValueAtTime(1, ctxRef.current.currentTime);
        }
        nextStartTimeRef.current = 0;
      }, 60); // slightly longer than fade to ensure completion
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  // ⚠️ AUDIO PIPELINE — flush() only clears isPlayingRef, it does NOT
  // stop scheduled buffers. Already-scheduled audio continues playing.
  // This is intentional — isTTSPlaying() falls back to time-based check.
  // Do not add stop() logic here; it would kill audio mid-playback.
  const flush = useCallback(() => {
    // Mark playback as no longer actively receiving chunks.
    // Scheduled buffers will finish playing; isTTSPlaying() falls back to
    // the time-based check for the remaining duration.
    isPlayingRef.current = false;
    queueRef.current = [];
  }, []);

  // ⚠️ AUDIO PIPELINE — Two-layer check: flag (immediate) + time-based (tail).
  // The flag catches the window between first chunk and enough scheduled audio.
  // The time check (100ms buffer) catches the tail after flush().
  // Both are needed — removing either breaks barge-in detection or echo suppression.
  /** Check if TTS audio is currently playing (scheduled buffers pending) */
  const isTTSPlaying = useCallback((): boolean => {
    // Flag is set immediately on first chunk, before enough audio is scheduled
    // for the time-based check to work. This ensures VAD uses the higher
    // TTS threshold from the very first chunk.
    if (isPlayingRef.current) return true;
    const ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") return false;
    return nextStartTimeRef.current > ctx.currentTime + 0.1;
  }, []);

  /** Create (or recreate) and resume AudioContext during a user gesture so
   *  Safari's autoplay policy allows audio output.  Safari silently blocks
   *  contexts created outside a gesture even when state reports "running". */
  const warmUp = useCallback(async () => {
    // Safari intermittent sessizlik için context'i kapatıp yeniden oluşturma.
    // Mevcut context'i koru; sadece running + prime uygula.
    const ctx = getContext(); // creates context + gain if missing
    await ensureRunning(ctx, "warmUp");

    // MediaElement fallback: ensure audio output unlocked for Safari.
    try {
      if (!mediaDestRef.current) {
        mediaDestRef.current = ctx.createMediaStreamDestination();
      }
      if (!mediaElRef.current) {
        const el = document.createElement("audio");
        // Keep element off-DOM; we only need its playback pipeline.
        el.autoplay = true;
        el.muted = false;
        el.volume = 1;
        mediaElRef.current = el;
      }
      if (mediaElRef.current.srcObject !== mediaDestRef.current.stream) {
        mediaElRef.current.srcObject = mediaDestRef.current.stream;
      }
      await mediaElRef.current.play();
      console.debug("[audio] media element play() ok");

      // Use exactly one output route to avoid echo.
      mediaRouteActiveRef.current = true;
      connectOutputRoute();
    } catch (err) {
      console.warn("[audio] media element play() failed:", err);
      mediaRouteActiveRef.current = false;
      connectOutputRoute();
    }

    // Safari sometimes needs a tiny playback to fully unlock audio output.
    try {
      const gain = getGain();
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start();
      source.stop(ctx.currentTime + 0.01);
    } catch (err) {
      console.warn("[audio] warmUp prime failed:", err);
    }

    // Optional debug tone: enable via console
    // window.__AUDIO_DEBUG_TONE__ = true
    if ((window as typeof window & { __AUDIO_DEBUG_TONE__?: boolean }).__AUDIO_DEBUG_TONE__ === true) {
      try {
        const gain = getGain();
        const osc = ctx.createOscillator();
        const testGain = ctx.createGain();
        testGain.gain.setValueAtTime(0.03, ctx.currentTime);
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.connect(testGain);
        testGain.connect(gain);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
        console.debug("[audio] test tone played");
      } catch (err) {
        console.warn("[audio] test tone failed:", err);
      }
    }

    console.debug("[audio] warmUp: ctx.state=", ctx.state, "sampleRate=", ctx.sampleRate);
  }, []);

  return { feedChunk, start, stop, flush, isTTSPlaying, warmUp };
}
