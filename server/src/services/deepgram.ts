/** STT service — real Deepgram Nova-3 implementation */

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { ListenLiveClient } from '@deepgram/sdk';

export interface STTCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
}

export interface STTService {
  start(callbacks: STTCallbacks): void;
  feedAudio(chunk: Buffer): void;
  /** Capture WebM init segment from audio chunk without feeding to Deepgram */
  saveHeader(chunk: Buffer): void;
  stop(): void;
}

/**
 * Extract the WebM initialization segment (EBML + Segment + Tracks) from a
 * MediaRecorder first-chunk, stripping any audio Cluster data.  The Cluster
 * element ID in EBML is the 4-byte sequence 0x1F 0x43 0xB6 0x75.  Everything
 * before the first Cluster is pure format metadata that Deepgram needs to
 * decode subsequent mid-stream clusters.
 */
function extractInitSegment(data: ArrayBuffer): ArrayBuffer {
  const view = new Uint8Array(data);
  for (let i = 0; i < view.length - 3; i++) {
    if (view[i] === 0x1f && view[i + 1] === 0x43 && view[i + 2] === 0xb6 && view[i + 3] === 0x75) {
      return data.slice(0, i);
    }
  }
  // No Cluster found — return as-is (shouldn't happen for valid WebM)
  return data;
}

export function createSTTService(): STTService {
  let connection: ListenLiveClient | null = null;
  let callbacks: STTCallbacks | null = null;
  let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  let transcriptBuffer = '';
  let isReady = false;
  let pendingChunks: ArrayBuffer[] = [];

  // WebM initialization segment (EBML header + Tracks) — no audio data.
  // Persists across STT cycles so new Deepgram connections can decode mid-stream data.
  let webmHeader: ArrayBuffer | null = null;

  /** Tear down current connection without logging (used internally by start) */
  function teardown() {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (connection) {
      try { connection.requestClose(); } catch { /* ignore */ }
      connection = null;
    }
    callbacks = null;
    transcriptBuffer = '';
    isReady = false;
    pendingChunks = [];
    // NOTE: webmHeader is intentionally NOT cleared — it persists across cycles
  }

  return {
    start(cb) {
      // Clean up any existing connection to prevent orphaned connections
      teardown();

      callbacks = cb;

      const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);
      connection = deepgram.listen.live({
        model: 'nova-3',
        language: 'tr',
        interim_results: true,
        endpointing: 300,
        utterance_end_ms: 1000,
        smart_format: true,
      });

      // Capture reference for stale connection guard — if a new start()
      // overwrites `connection`, old event handlers become no-ops.
      const conn = connection;

      conn.on(LiveTranscriptionEvents.Open, () => {
        if (connection !== conn) return; // stale
        console.log('[stt] deepgram connection opened');
        isReady = true;

        // Replay WebM header so Deepgram can decode mid-stream clusters
        if (webmHeader) {
          conn.send(webmHeader);
        }

        // Flush audio that arrived before connection was ready
        for (const chunk of pendingChunks) {
          conn.send(chunk);
        }
        pendingChunks = [];
      });

      conn.on(LiveTranscriptionEvents.Transcript, (data) => {
        if (connection !== conn) return; // stale
        const alt = data.channel?.alternatives?.[0];
        if (!alt) return;
        const text = alt.transcript;
        if (!text) return;

        if (data.is_final) {
          // Accumulate final segments
          transcriptBuffer += (transcriptBuffer ? ' ' : '') + text;
          callbacks?.onTranscript(transcriptBuffer, false);

          if (data.speech_final) {
            // Utterance complete — flush
            callbacks?.onTranscript(transcriptBuffer, true);
            transcriptBuffer = '';
          }
        } else {
          // Interim: show buffered + current interim
          const interim = transcriptBuffer
            ? transcriptBuffer + ' ' + text
            : text;
          callbacks?.onTranscript(interim, false);
        }
      });

      conn.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        if (connection !== conn) return; // stale
        // Safety flush if we have buffered text
        if (transcriptBuffer && callbacks) {
          callbacks.onTranscript(transcriptBuffer, true);
          transcriptBuffer = '';
        }
      });

      conn.on(LiveTranscriptionEvents.Error, (err) => {
        if (connection !== conn) return; // stale
        console.error('[stt] deepgram error:', err);
      });

      conn.on(LiveTranscriptionEvents.Close, () => {
        console.log('[stt] deepgram connection closed');
      });

      // KeepAlive every 5 seconds
      keepAliveInterval = setInterval(() => {
        if (connection) {
          connection.keepAlive();
        }
      }, 5000);
    },

    saveHeader(chunk: Buffer) {
      if (webmHeader) return;
      const ab = new Uint8Array(chunk).buffer as ArrayBuffer;
      const candidate = extractInitSegment(ab);
      if (candidate.byteLength > 0) {
        webmHeader = candidate;
        console.log('[stt] webm init segment saved (%d bytes, stripped from %d)', webmHeader.byteLength, ab.byteLength);
      }
    },

    feedAudio(chunk: Buffer) {
      if (!connection) return;
      const ab = new Uint8Array(chunk).buffer as ArrayBuffer;

      // Save the init segment (EBML + Tracks, no audio) from the first chunk
      if (!webmHeader) {
        const candidate = extractInitSegment(ab);
        if (candidate.byteLength > 0) {
          webmHeader = candidate;
          console.log('[stt] webm init segment saved (%d bytes, stripped from %d)', webmHeader.byteLength, ab.byteLength);
        }
      }

      if (isReady) {
        connection.send(ab);
      } else {
        // Buffer audio until Deepgram WebSocket is open
        pendingChunks.push(ab);
      }
    },

    stop() {
      teardown();
      console.log('[stt] stopped');
    },
  };
}
