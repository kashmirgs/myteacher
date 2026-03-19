import { useEffect, useRef, useState, useCallback } from 'react';
import type { ClientMessage, ServerMessage } from '@myteacher/shared';

const WS_URL = window.location.protocol === 'https:'
  ? `wss://${window.location.host}/ws`
  : `ws://${window.location.hostname}:3001`;
const MAX_RECONNECT_DELAY = 8000;

/**
 * WebSocket hook with ref-based message callback.
 *
 * Messages are dispatched synchronously via a ref — this avoids React 18
 * automatic batching which can silently drop rapid-fire messages (e.g. TTS
 * chunks) when they all resolve within the same render frame.
 */
export function useSocket(onMessage: (msg: ServerMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage; // always keep latest closure
  const [isConnected, setIsConnected] = useState(false);

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setIsConnected(true);
      reconnectDelay.current = 1000;
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;

      // Binary frames are handled separately (audio playback)
      if (event.data instanceof Blob) return;

      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        onMessageRef.current(msg);
      } catch {
        console.error('[ws] invalid message', event.data);
      }
    };

    ws.onclose = () => {
      // Only reconnect if this is still the active connection.
      // Prevents orphaned WS (from StrictMode double-mount) from spawning duplicates.
      if (wsRef.current !== ws) return;
      setIsConnected(false);
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendBinary = useCallback((data: Blob | ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  return { send, sendBinary, isConnected };
}
