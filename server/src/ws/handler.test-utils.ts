import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type { STTService, STTCallbacks } from "../services/deepgram.js";
import type { TTSService, TTSCallbacks, TTSStreamHandle } from "../services/cartesia.js";
import type { LLMService, LLMStreamCallbacks, LLMStreamHandle } from "../services/claude.js";

// ── Type aliases for augmented mocks ──

export type MockSTT = Omit<STTService, "start" | "feedAudio" | "stop"> & {
  _startCb: STTCallbacks | null;
  start: ReturnType<typeof vi.fn>;
  feedAudio: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};
export type MockTTS = Omit<TTSService, "streamTTS" | "openStream" | "stop"> & {
  _streamCb: TTSCallbacks | null;
  _lastText: string | null;
  _openStreamCb: TTSCallbacks | null;
  _openStreamCalls: TTSCallbacks[];
  _feedCalls: { text: string; isFinal: boolean }[];
  streamTTS: ReturnType<typeof vi.fn>;
  openStream: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};
export type MockLLM = Omit<
  LLMService,
  "generateLesson" | "generateSpeechResponse" | "streamSpeechResponse" | "answerAnnotation" | "generateBoardOnly"
> & {
  _streamCb: LLMStreamCallbacks | null;
  _abortFn: ReturnType<typeof vi.fn>;
  generateLesson: ReturnType<typeof vi.fn>;
  generateSpeechResponse: ReturnType<typeof vi.fn>;
  streamSpeechResponse: ReturnType<typeof vi.fn>;
  answerAnnotation: ReturnType<typeof vi.fn>;
  generateBoardOnly: ReturnType<typeof vi.fn>;
};

// ── Mock factories ──

export function createMockSTT(): MockSTT {
  return {
    _startCb: null as STTCallbacks | null,
    start: vi.fn(function (this: MockSTT, cb: STTCallbacks) {
      this._startCb = cb;
    }),
    feedAudio: vi.fn(),
    stop: vi.fn(),
  };
}

export function createMockTTS(): MockTTS {
  return {
    _streamCb: null as TTSCallbacks | null,
    _lastText: null as string | null,
    _openStreamCb: null as TTSCallbacks | null,
    _openStreamCalls: [] as TTSCallbacks[],
    _feedCalls: [] as { text: string; isFinal: boolean }[],
    streamTTS: vi.fn(function (this: MockTTS, text: string, cb: TTSCallbacks) {
      this._lastText = text;
      this._streamCb = cb;
    }),
    openStream: vi.fn(function (this: MockTTS, cb: TTSCallbacks): TTSStreamHandle {
      this._openStreamCb = cb;
      this._openStreamCalls.push(cb);
      this._feedCalls = [];
      const self = this;
      return {
        feed(text: string, isFinal: boolean) {
          self._feedCalls.push({ text, isFinal });
        },
      };
    }),
    stop: vi.fn(),
  };
}

export function createMockLLM(): MockLLM {
  const abortFn = vi.fn();
  return {
    _streamCb: null as LLMStreamCallbacks | null,
    _abortFn: abortFn,
    generateLesson: vi.fn().mockResolvedValue([]),
    generateSpeechResponse: vi.fn().mockResolvedValue("Mocked LLM response"),
    streamSpeechResponse: vi.fn(function (
      this: MockLLM,
      _transcript: string,
      _history: unknown,
      callbacks: LLMStreamCallbacks,
    ): LLMStreamHandle {
      this._streamCb = callbacks;
      // Default behavior: emit full text on next microtask (preserves async timing)
      queueMicrotask(() => {
        callbacks.onToken("Mocked LLM response", "Mocked LLM response");
        callbacks.onDone("Mocked LLM response");
      });
      const abort = this._abortFn as unknown as () => void;
      return { abort: () => abort() };
    }),
    answerAnnotation: vi.fn().mockResolvedValue("Mocked annotation answer"),
    generateBoardOnly: vi.fn().mockResolvedValue([{ type: "text", text: "fallback board" }]),
  };
}

// ── FakeWebSocket ──

export class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1; // OPEN

  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  /** Helper: simulate receiving a JSON message from client */
  receiveJSON(msg: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }

  /** Helper: simulate receiving binary audio from client */
  receiveAudio(data?: Buffer) {
    this.emit("message", data ?? Buffer.from([0x01, 0x02, 0x03]), true);
  }

  /** Helper: get parsed sent messages */
  get sentMessages() {
    return this.sent.map((s) => JSON.parse(s));
  }

  /** Helper: find specific sent message type */
  sentOfType(type: string) {
    return this.sentMessages.filter((m: Record<string, unknown>) => m.type === type);
  }
}
