import { bench, describe, vi, beforeEach } from "vitest";
import {
  createMockSTT,
  createMockTTS,
  createMockLLM,
  FakeWebSocket,
  type MockSTT,
  type MockTTS,
  type MockLLM,
} from "./handler.test-utils.js";

// ── Mocks ──

let mockSTT: MockSTT;
let mockTTS: MockTTS;
let mockLLM: MockLLM;

vi.mock("../services/deepgram.js", () => ({
  createSTTService: () => mockSTT,
}));

vi.mock("../services/cartesia.js", () => ({
  createTTSService: () => mockTTS,
}));

vi.mock("../services/claude.js", () => ({
  createLLMService: () => mockLLM,
}));

const { handleConnection } = await import("./handler.js");

function freshConnection() {
  mockSTT = createMockSTT();
  mockTTS = createMockTTS();
  mockLLM = createMockLLM();
  const ws = new FakeWebSocket();
  handleConnection(ws as never);
  return ws;
}

async function driveToSpeaking(ws: FakeWebSocket) {
  ws.receiveJSON({ type: "start_listening" });
  mockSTT._startCb!.onTranscript("hello", true);
  // LLM mock resolves on next microtask
  await vi.waitFor(() => {
    if (!mockTTS.streamTTS.mock.calls.length) throw new Error("waiting");
  });
}

// ── Sync benchmarks: fresh connection per iteration via setup callback ──

describe("handler message routing", () => {
  let ws: FakeWebSocket;

  bench(
    "JSON parse + route: start_listening",
    () => {
      ws.receiveJSON({ type: "start_listening" });
    },
    {
      setup: () => {
        ws = freshConnection();
      },
    },
  );

  bench(
    "JSON parse + route: stop_listening",
    () => {
      ws.receiveJSON({ type: "start_listening" });
      ws.receiveJSON({ type: "stop_listening" });
    },
    {
      setup: () => {
        ws = freshConnection();
      },
    },
  );

  bench(
    "binary audio feed (listening)",
    () => {
      ws.receiveAudio(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    },
    {
      setup: () => {
        ws = freshConnection();
        ws.receiveJSON({ type: "start_listening" });
      },
    },
  );

  bench(
    "invalid JSON handling",
    () => {
      ws.emit("message", Buffer.from("not json{{{"), false);
    },
    {
      setup: () => {
        ws = freshConnection();
      },
    },
  );
});

// ── Async benchmarks: need speaking state ──

describe("handler audio + barge-in", () => {
  let ws: FakeWebSocket;

  bench(
    "binary audio buffer (speaking)",
    () => {
      ws.receiveAudio(Buffer.from([0xaa, 0xbb]));
    },
    {
      setup: async () => {
        ws = freshConnection();
        await driveToSpeaking(ws);
      },
    },
  );

  bench(
    "full barge-in cycle",
    () => {
      ws.receiveAudio(Buffer.from([0xdd]));
      ws.receiveJSON({ type: "barge_in" });
    },
    {
      setup: async () => {
        ws = freshConnection();
        await driveToSpeaking(ws);
      },
    },
  );
});
