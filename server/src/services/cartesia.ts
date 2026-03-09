/** TTS service — real Cartesia WebSocket implementation (raw ws) */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export interface TTSCallbacks {
  onChunk: (audio: string) => void;
  onStart: () => void;
  onEnd: () => void;
}

export interface TTSStreamHandle {
  feed(text: string, isFinal: boolean): void;
}

export interface TTSService {
  streamTTS(text: string, callbacks: TTSCallbacks): void;
  openStream(callbacks: TTSCallbacks): TTSStreamHandle;
  stop(): void;
}

const CARTESIA_WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_VERSION = '2025-04-16';
const VOICE_ID = process.env.CARTESIA_VOICE_ID!;
const MODEL_ID = 'sonic-3';

export function createTTSService(): TTSService {
  let ws: WebSocket | null = null;
  let currentContextId: string | null = null;
  let active = false;

  function cleanup() {
    active = false;
    currentContextId = null;
    if (ws) {
      const socket = ws;
      ws = null;
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          // Can't close a CONNECTING socket cleanly — terminate it
          socket.terminate();
        }
      } catch {
        // Ignore close/terminate errors
      }
    }
  }

  return {
    streamTTS(text, callbacks) {
      cleanup(); // Close previous stream before opening new one
      active = true;
      const contextId = randomUUID();
      currentContextId = contextId;

      const apiKey = process.env.CARTESIA_API_KEY!;
      const url = `${CARTESIA_WS_URL}?api_key=${apiKey}&cartesia_version=${CARTESIA_VERSION}`;

      ws = new WebSocket(url);

      ws.on('open', () => {
        if (!active || currentContextId !== contextId) return;
        console.log('[tts] cartesia websocket opened');
        callbacks.onStart();

        const request = {
          model_id: MODEL_ID,
          transcript: text,
          voice: {
            mode: 'id',
            id: VOICE_ID,
          },
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 24000,
          },
          context_id: contextId,
          language: 'tr',
        };

        ws?.send(JSON.stringify(request));
      });

      let chunkCount = 0;

      ws.on('message', (data) => {
        if (!active || currentContextId !== contextId) return;

        try {
          const msg = JSON.parse(data.toString());

          if (msg.context_id !== contextId) return;

          if (msg.type === 'chunk' && msg.data) {
            chunkCount++;
            if (chunkCount === 1) console.log('[tts] first audio chunk from cartesia');
            callbacks.onChunk(msg.data);
          } else if (msg.type === 'done') {
            console.log(`[tts] cartesia stream done (${chunkCount} chunks)`);
            active = false;
            callbacks.onEnd();
            if (currentContextId === contextId) cleanup();
          } else if (msg.type === 'error') {
            console.error('[tts] cartesia error:', msg.message || msg);
            active = false;
            callbacks.onEnd();
            if (currentContextId === contextId) cleanup();
          } else {
            console.log('[tts] cartesia unhandled msg:', msg.type, JSON.stringify(msg).slice(0, 200));
          }
        } catch (err) {
          console.error('[tts] failed to parse cartesia message:', err);
        }
      });

      ws.on('error', (err) => {
        console.error('[tts] cartesia ws error:', err);
        if (currentContextId !== contextId) return;
        if (active) {
          active = false;
          callbacks.onEnd();
        }
        if (currentContextId === contextId) cleanup();
      });

      ws.on('close', () => {
        console.log('[tts] cartesia websocket closed');
        if (currentContextId !== contextId) return;
        if (active) {
          active = false;
          callbacks.onEnd();
        }
      });
    },

    openStream(callbacks: TTSCallbacks): TTSStreamHandle {
      cleanup(); // Close previous stream before opening new one
      active = true;
      const contextId = randomUUID();
      currentContextId = contextId;

      const apiKey = process.env.CARTESIA_API_KEY!;
      const url = `${CARTESIA_WS_URL}?api_key=${apiKey}&cartesia_version=${CARTESIA_VERSION}`;

      ws = new WebSocket(url);
      let ready = false;
      let chunkCount = 0;
      const pendingClauses: { text: string; isFinal: boolean }[] = [];

      function sendClause(text: string, isFinal: boolean) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          console.warn('[tts] sendClause skipped — ws not open');
          return;
        }
        console.log(`[tts] sendClause (${text.length} chars, final=${isFinal}): "${text.slice(0, 50)}..."`);
        const request = {
          model_id: MODEL_ID,
          transcript: text,
          voice: { mode: 'id', id: VOICE_ID },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          context_id: contextId,
          language: 'tr',
          continue: !isFinal,
        };
        ws.send(JSON.stringify(request));
      }

      ws.on('open', () => {
        if (!active || currentContextId !== contextId) return;
        console.log('[tts] cartesia websocket opened (streaming)');
        ready = true;
        callbacks.onStart();
        // Flush any clauses that arrived before WS was ready
        for (const clause of pendingClauses) {
          sendClause(clause.text, clause.isFinal);
        }
        pendingClauses.length = 0;
      });

      ws.on('message', (data) => {
        if (!active || currentContextId !== contextId) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.context_id !== contextId) return;

          if (msg.type === 'chunk' && msg.data) {
            chunkCount++;
            if (chunkCount === 1) console.log('[tts] first audio chunk from cartesia');
            callbacks.onChunk(msg.data);
          } else if (msg.type === 'done') {
            console.log(`[tts] cartesia stream done (${chunkCount} chunks)`);
            active = false;
            // onEnd may open a new stream (e.g. lesson resume), so only
            // clean up if no new stream was started during the callback.
            callbacks.onEnd();
            if (currentContextId === contextId) cleanup();
          } else if (msg.type === 'error') {
            console.error('[tts] cartesia error:', msg.message || msg);
            active = false;
            callbacks.onEnd();
            if (currentContextId === contextId) cleanup();
          } else {
            console.log('[tts] cartesia unhandled msg:', msg.type, JSON.stringify(msg).slice(0, 200));
          }
        } catch (err) {
          console.error('[tts] failed to parse cartesia message:', err);
        }
      });

      ws.on('error', (err) => {
        console.error('[tts] cartesia ws error:', err);
        if (currentContextId !== contextId) return;
        if (active) {
          active = false;
          callbacks.onEnd();
        }
        if (currentContextId === contextId) cleanup();
      });

      ws.on('close', () => {
        console.log('[tts] cartesia websocket closed');
        if (currentContextId !== contextId) return;
        if (active) {
          active = false;
          callbacks.onEnd();
        }
      });

      return {
        feed(text: string, isFinal: boolean) {
          if (!active || currentContextId !== contextId) return;
          if (!ready) {
            pendingClauses.push({ text, isFinal });
            return;
          }
          sendClause(text, isFinal);
        },
      };
    },

    stop() {
      if (ws && currentContextId && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            context_id: currentContextId,
            cancel: true,
          }));
        } catch {
          // Ignore send errors
        }
      }
      cleanup();
      console.log('[tts] stopped');
    },
  };
}
