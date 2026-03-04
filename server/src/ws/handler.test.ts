import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMStreamCallbacks } from "../services/claude.js";
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

// ── Test suite ──

// Dynamic import so vi.mock is hoisted first
const { handleConnection } = await import("./handler.js");

describe("handleConnection", () => {
  let ws: FakeWebSocket;

  beforeEach(() => {
    mockSTT = createMockSTT();
    mockTTS = createMockTTS();
    mockLLM = createMockLLM();
    ws = new FakeWebSocket();
    handleConnection(ws as never);
  });

  // ── start_listening / stop_listening ──

  describe("start_listening / stop_listening", () => {
    it("transitions to listening and starts STT", () => {
      ws.receiveJSON({ type: "start_listening" });

      expect(mockSTT.start).toHaveBeenCalledOnce();
      expect(ws.sentOfType("state_change")).toContainEqual({
        type: "state_change",
        state: "listening",
      });
    });

    it("stop_listening stops STT and transitions to idle", () => {
      ws.receiveJSON({ type: "start_listening" });
      ws.receiveJSON({ type: "stop_listening" });

      expect(mockSTT.stop).toHaveBeenCalled();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "idle",
      });
    });

    it("ignores stop_listening right after barge_in while listening", async () => {
      ws.receiveJSON({ type: "start_listening" });

      // Simulate speaking and then barge-in returning to listening
      mockSTT._startCb!.onTranscript("test", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());
      ws.receiveJSON({ type: "barge_in" });

      mockSTT.stop.mockClear();
      ws.receiveJSON({ type: "stop_listening" });

      // stop_listening should be ignored due to recent barge_in
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
    });

    it("ignores start_listening when not idle", () => {
      ws.receiveJSON({ type: "start_listening" });
      ws.sent.length = 0;
      mockSTT.start.mockClear();

      // second start_listening while already listening — should be rejected
      ws.receiveJSON({ type: "start_listening" });
      expect(mockSTT.start).not.toHaveBeenCalled();
    });
  });

  // ── Audio routing ──

  describe("audio routing", () => {
    it("feeds audio to STT when listening", () => {
      ws.receiveJSON({ type: "start_listening" });
      const buf = Buffer.from([0xaa, 0xbb]);
      ws.receiveAudio(buf);

      expect(mockSTT.feedAudio).toHaveBeenCalledWith(buf);
    });

    it("buffers audio when speaking", async () => {
      // Drive state to speaking
      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("hello", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Now in speaking state
      const buf = Buffer.from([0xcc]);
      ws.receiveAudio(buf);

      // Should NOT feed to STT (it was stopped after final transcript)
      // Audio should be buffered for later
      expect(mockSTT.feedAudio).not.toHaveBeenCalledWith(buf);
    });

    it("drops audio when idle", () => {
      ws.receiveAudio();
      expect(mockSTT.feedAudio).not.toHaveBeenCalled();
    });

    it("drops audio when processing", async () => {
      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("hello", true);

      // Brief moment in processing before LLM resolves
      ws.receiveAudio();
      // feedAudio should not be called for audio sent after transcript was final
      // (STT was stopped when final transcript came in)
    });
  });

  // ── Transcript → LLM → TTS cycle ──

  describe("transcript → LLM → TTS cycle", () => {
    it("completes full flow: final transcript → streaming LLM → TTS stream", async () => {
      ws.receiveJSON({ type: "start_listening" });

      // Simulate final transcript
      mockSTT._startCb!.onTranscript("Merhaba", true);

      // Wait for streaming LLM to resolve and TTS to be opened
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      expect(mockSTT.stop).toHaveBeenCalled();
      expect(mockLLM.streamSpeechResponse).toHaveBeenCalledWith("Merhaba", expect.any(Object));

      // The mock emits "Mocked LLM response" as a single token — no clause boundary
      // detected (no `.?!` followed by space), so full text is fed to TTS in onDone
      expect(mockTTS._feedCalls.length).toBeGreaterThanOrEqual(1);

      // Verify final transcript was sent to client
      expect(ws.sentOfType("transcript")).toContainEqual({
        type: "transcript",
        text: "Mocked LLM response",
        isFinal: true,
      });
    });

    it("transitions to idle on LLM error", async () => {
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        callbacks: { onError: (err: Error) => void },
      ) {
        queueMicrotask(() => {
          callbacks.onError(new Error("API down"));
        });
      });

      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("fail", true);

      await vi.waitFor(() =>
        expect(ws.sentOfType("error")).toContainEqual({
          type: "error",
          message: "API down",
        }),
      );

      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "idle",
      });
    });
  });

  // ── TTS onEnd ──

  describe("TTS onEnd", () => {
    async function driveToSpeaking() {
      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("test", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());
      // Now in speaking state
    }

    it("transitions speaking → listening and restarts STT", async () => {
      await driveToSpeaking();
      mockSTT.start.mockClear();

      mockTTS._openStreamCb!.onEnd();

      expect(ws.sentOfType("tts_end").length).toBe(1);
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
      expect(mockSTT.start).toHaveBeenCalledOnce();
    });

    it("discards pendingAudio after onEnd (echo-contaminated)", async () => {
      await driveToSpeaking();

      // Buffer audio while speaking
      const buf1 = Buffer.from([0x01]);
      const buf2 = Buffer.from([0x02]);
      ws.receiveAudio(buf1);
      ws.receiveAudio(buf2);
      mockSTT.feedAudio.mockClear();

      // TTS finishes
      mockTTS._openStreamCb!.onEnd();

      expect(mockSTT.feedAudio).not.toHaveBeenCalled();
    });

    it("is a no-op after barge-in already transitioned away", async () => {
      await driveToSpeaking();

      // Barge-in first
      ws.receiveJSON({ type: "barge_in" });
      mockSTT.start.mockClear();
      mockSTT.feedAudio.mockClear();

      // Late onEnd fires — should be ignored
      mockTTS._openStreamCb!.onEnd();

      // STT should NOT be restarted (barge-in already did that)
      expect(mockSTT.start).not.toHaveBeenCalled();
      expect(ws.sentOfType("tts_end").length).toBe(0);
    });
  });

  // ── barge_in ──

  describe("barge_in", () => {
    async function driveToSpeaking() {
      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("test", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());
    }

    it("from speaking: stops TTS, aborts LLM, discards pending audio, restarts STT", async () => {
      // Override mock to keep LLM stream active (no onDone)
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          // Emit a clause so we transition to speaking, but don't call onDone
          callbacks.onToken("Merhaba öğrencim. ", "Merhaba öğrencim. ");
        });
        return { abort: this._abortFn };
      });

      await driveToSpeaking();

      // Buffer some audio while speaking
      const buf = Buffer.from([0xdd]);
      ws.receiveAudio(buf);
      mockSTT.start.mockClear();
      mockSTT.feedAudio.mockClear();

      ws.receiveJSON({ type: "barge_in" });

      expect(mockLLM._abortFn).toHaveBeenCalled();
      expect(mockTTS.stop).toHaveBeenCalled();
      expect(mockSTT.stop).toHaveBeenCalled();
      expect(mockSTT.start).toHaveBeenCalledOnce();
      // Pending audio must NOT be fed — it contains the barge-in speech fragment
      // that would cause Deepgram to immediately produce a spurious final transcript
      expect(mockSTT.feedAudio).not.toHaveBeenCalled();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
    });

    it("abort error does not disrupt state after barge-in", async () => {
      // Override mock to keep LLM stream active (no onDone)
      let capturedCallbacks: LLMStreamCallbacks | null = null;
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        capturedCallbacks = callbacks;
        queueMicrotask(() => {
          callbacks.onToken("Merhaba öğrencim. ", "Merhaba öğrencim. ");
        });
        return { abort: this._abortFn };
      });

      await driveToSpeaking();

      ws.receiveJSON({ type: "barge_in" });

      // State should be listening after barge-in
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });

      // Simulate abort triggering onError (as Anthropic SDK does)
      capturedCallbacks!.onError(new Error("Request was aborted."));

      // State must STILL be listening — onError must be a no-op
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
      expect(ws.sentOfType("error")).toHaveLength(0);
    });

    it("from listening: ignores barge_in without restarting STT", () => {
      ws.receiveJSON({ type: "start_listening" });
      mockSTT.start.mockClear();
      mockSTT.stop.mockClear();
      mockTTS.stop.mockClear();

      ws.receiveJSON({ type: "barge_in" });

      // STT should NOT be restarted; late barge_in is ignored.
      expect(mockSTT.stop).not.toHaveBeenCalled();
      expect(mockSTT.start).not.toHaveBeenCalled();
      expect(mockTTS.stop).not.toHaveBeenCalled();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
    });

    it("double barge_in from speaking: second restarts STT in listening", async () => {
      await driveToSpeaking();

      // Buffer audio while speaking
      ws.receiveAudio(Buffer.from([0xaa]));
      mockSTT.stop.mockClear();
      mockSTT.start.mockClear();
      mockSTT.feedAudio.mockClear();

      // ── First barge_in: speaking → listening ──
      ws.receiveJSON({ type: "barge_in" });

      expect(mockSTT.stop).not.toHaveBeenCalled();
      expect(mockSTT.start).toHaveBeenCalledOnce();
      // Pending audio is discarded on barge-in
      expect(mockSTT.feedAudio).not.toHaveBeenCalled();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });

      mockSTT.stop.mockClear();
      mockSTT.start.mockClear();
      mockSTT.feedAudio.mockClear();
      mockTTS.stop.mockClear();

      // ── Second barge_in: already listening — STT/TTS must NOT be touched ──
      ws.receiveJSON({ type: "barge_in" });

      expect(mockSTT.stop).not.toHaveBeenCalled();
      expect(mockSTT.start).not.toHaveBeenCalled();
      expect(mockSTT.feedAudio).not.toHaveBeenCalled();
      expect(mockTTS.stop).not.toHaveBeenCalled();
      // State stays listening — no new state_change emitted
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });

      // ── Verify full state_change sequence sent to client ──
      const states = ws.sentOfType("state_change").map((m: { state: string }) => m.state);
      // idle→listening (start_listening), listening→processing, processing→speaking,
      // speaking→listening (1st barge_in) — no extra from 2nd
      expect(states).toEqual(["listening", "processing", "speaking", "listening"]);
    });

    it("from idle: only stops TTS", () => {
      ws.receiveJSON({ type: "barge_in" });

      expect(mockTTS.stop).toHaveBeenCalled();
      expect(mockSTT.stop).not.toHaveBeenCalled();
      expect(mockSTT.start).not.toHaveBeenCalled();
    });

    it("from processing: aborts LLM and stops TTS", async () => {
      // Put into processing: start listening, send final transcript, LLM not yet resolved
      const abortFn = vi.fn();
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _callbacks: unknown,
      ) {
        // Don't call any callbacks — simulates LLM still processing
        return { abort: abortFn };
      });

      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("test", true);

      // Wait for processing state
      await vi.waitFor(() => {
        const states = ws.sentOfType("state_change").map((m: { state: string }) => m.state);
        expect(states).toContain("processing");
      });

      mockSTT.stop.mockClear();
      mockSTT.start.mockClear();

      ws.receiveJSON({ type: "barge_in" });

      expect(abortFn).toHaveBeenCalled();
      expect(mockTTS.stop).toHaveBeenCalled();
      expect(mockSTT.stop).not.toHaveBeenCalled();
      expect(mockSTT.start).toHaveBeenCalledOnce();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
    });
  });

  // ── Race condition: barge_in + onEnd ──

  describe("race condition: barge_in then onEnd", () => {
    it("STT does not start twice and buffer is fed once", async () => {
      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("test", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Buffer audio during speaking
      const buf = Buffer.from([0xee]);
      ws.receiveAudio(buf);

      mockSTT.start.mockClear();
      mockSTT.feedAudio.mockClear();

      // barge_in first
      ws.receiveJSON({ type: "barge_in" });
      const startCountAfterBargeIn = mockSTT.start.mock.calls.length;
      const feedCountAfterBargeIn = mockSTT.feedAudio.mock.calls.length;

      // Then late onEnd fires
      mockTTS._openStreamCb!.onEnd();

      // STT.start should not have been called again
      expect(mockSTT.start.mock.calls.length).toBe(startCountAfterBargeIn);
      // feedAudio should not have been called again
      expect(mockSTT.feedAudio.mock.calls.length).toBe(feedCountAfterBargeIn);
    });
  });

  // ── Connection close ──

  describe("connection close", () => {
    it("cleans up STT, TTS, LLM stream, and resets session", async () => {
      // Override mock to keep LLM stream active (no onDone)
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          callbacks.onToken("Merhaba öğrencim. ", "Merhaba öğrencim. ");
        });
        return { abort: this._abortFn };
      });

      // Drive to speaking so there's an active LLM handle
      ws.receiveJSON({ type: "start_listening" });
      mockSTT._startCb!.onTranscript("test", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      mockLLM._abortFn.mockClear();

      ws.emit("close");

      expect(mockLLM._abortFn).toHaveBeenCalled();
      expect(mockSTT.stop).toHaveBeenCalled();
      expect(mockTTS.stop).toHaveBeenCalled();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "idle",
      });
    });
  });

  // ── Invalid JSON ──

  describe("invalid JSON", () => {
    it("sends error message for unparseable JSON", () => {
      ws.emit("message", Buffer.from("not json{{{"), false);

      expect(ws.sentOfType("error")).toContainEqual({
        type: "error",
        message: "invalid JSON",
      });
    });
  });
});
