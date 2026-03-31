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
      expect(mockLLM.streamSpeechResponse).toHaveBeenCalledWith("Merhaba", expect.any(Object), expect.any(Object), undefined);

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
        _history: unknown,
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

    it("transitions speaking → listening, awaits overlay dismiss", async () => {
      await driveToSpeaking();
      mockSTT.start.mockClear();

      mockTTS._openStreamCb!.onEnd();

      expect(ws.sentOfType("tts_end").length).toBe(1);
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
      expect(mockSTT.start).toHaveBeenCalledOnce();
      // qa_board_clear should NOT be sent yet (awaiting overlay dismiss)
      expect(ws.sentOfType("qa_board_clear")).toHaveLength(0);
    });

    it("sends qa_board_clear on overlay dismiss after TTS end", async () => {
      await driveToSpeaking();
      mockTTS._openStreamCb!.onEnd();

      // Simulate client dismissing the overlay
      ws.receiveJSON({ type: "qa_overlay_dismiss" });

      expect(ws.sentOfType("qa_board_clear")).toHaveLength(1);
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
        _history: unknown,
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
        _history: unknown,
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
        _history: unknown,
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
        _history: unknown,
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

  // ── Barge-in during lesson → Q&A → resume ──

  describe("barge-in during lesson → Q&A → resume", () => {
    const lessonItems = [
      { type: "heading", text: "Test Lesson", speech: "" },
      { type: "text", text: "Item 1", speech: "Speech for item one." },
      { type: "text", text: "Item 2", speech: "Speech for item two." },
      { type: "text", text: "Item 3", speech: "Speech for item three." },
    ];

    async function startLesson() {
      (mockLLM.generateLesson as ReturnType<typeof vi.fn>).mockResolvedValueOnce(lessonItems);
      ws.receiveJSON({ type: "generate_lesson", topic: "test" });
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());
    }

    it("barge-in during lesson → Q&A → resume sends board_reveal for remaining items", async () => {
      await startLesson();

      // Verify initial board_update and board_reveal for title (index 0)
      expect(ws.sentOfType("board_update")).toHaveLength(1);
      expect(ws.sentOfType("board_reveal")).toContainEqual({ type: "board_reveal", index: 0 });

      // Session should be in speaking state
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "speaking",
      });

      // Track the initial openStream call count
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;
      expect(initialOpenStreamCount).toBe(1);

      // ── Barge-in during lesson narration ──
      ws.receiveJSON({ type: "barge_in" });

      expect(mockTTS.stop).toHaveBeenCalled();
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });

      // ── User asks a question (final transcript) — LLM responds with board ──
      // Override LLM to emit a clause with board marker so we transition to speaking
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = 'Evet, doğru. \n---BOARD---\n[{"type":"text","text":"açıklama"}]';
          callbacks.onToken("Evet, doğru. ", "Evet, doğru. ");
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("Bu ne demek?", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalledTimes(initialOpenStreamCount + 1));

      // Should be in speaking state for Q&A answer
      await vi.waitFor(() => {
        expect(ws.sentOfType("state_change").at(-1)).toEqual({
          type: "state_change",
          state: "speaking",
        });
      });

      // ── Q&A TTS ends → overlay dismiss awaited ──
      const qaStreamCb = mockTTS._openStreamCalls[initialOpenStreamCount];
      qaStreamCb.onEnd();

      // tts_end sent, state transitions to listening (awaiting dismiss)
      expect(ws.sentOfType("tts_end").length).toBeGreaterThanOrEqual(1);
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });

      // qa_board_clear NOT yet sent (awaiting dismiss)
      const clearCountBefore = ws.sentOfType("qa_board_clear").length;

      // ── Client sends overlay dismiss → lesson resumes ──
      ws.receiveJSON({ type: "qa_overlay_dismiss" });

      // qa_board_clear sent after dismiss
      expect(ws.sentOfType("qa_board_clear").length).toBe(clearCountBefore + 1);

      // resumeLesson should have opened another TTS stream
      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 2);
      });

      const ttsEndCount = ws.sentOfType("tts_end").length;

      // board_reveal events should be sent for remaining items
      const reveals = ws.sentOfType("board_reveal").map((m: { index: number }) => m.index);
      expect(reveals).toContain(1);

      // Session should be in speaking (resumed)
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "speaking",
      });

      // ── Resumed lesson TTS ends → now transition to listening ──
      const resumeStreamCb = mockTTS._openStreamCalls[initialOpenStreamCount + 1];
      resumeStreamCb.onEnd();

      // NOW tts_end should be sent
      expect(ws.sentOfType("tts_end").length).toBe(ttsEndCount + 1);
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });
      expect(mockSTT.start).toHaveBeenCalled();
    });

    it("resume sends state_change:speaking on first TTS chunk (grace period reset)", async () => {
      await startLesson();
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;

      // Barge-in during lesson
      ws.receiveJSON({ type: "barge_in" });

      // Q&A with board marker
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = 'Evet, doğru. \n---BOARD---\n[{"type":"text","text":"açıklama"}]';
          callbacks.onToken("Evet, doğru. ", "Evet, doğru. ");
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("Bu ne?", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalledTimes(initialOpenStreamCount + 1));
      await vi.waitFor(() => {
        expect(ws.sentOfType("state_change").at(-1)).toEqual({
          type: "state_change",
          state: "speaking",
        });
      });

      // Q&A TTS ends → awaiting dismiss (board was sent)
      const qaStreamCb = mockTTS._openStreamCalls[initialOpenStreamCount];
      qaStreamCb.onEnd();

      // Dismiss overlay → resume starts
      ws.receiveJSON({ type: "qa_overlay_dismiss" });

      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 2);
      });

      // Count state_change:speaking messages before simulating TTS chunk
      const speakingCountBefore = ws.sentOfType("state_change")
        .filter((m: { state: string }) => m.state === "speaking").length;

      // Simulate first resume TTS chunk arriving from Cartesia
      const resumeStreamCb = mockTTS._openStreamCalls[initialOpenStreamCount + 1];
      resumeStreamCb.onChunk("base64audiodata");

      // Should have sent an extra state_change:speaking for grace period reset
      const speakingCountAfter = ws.sentOfType("state_change")
        .filter((m: { state: string }) => m.state === "speaking").length;
      expect(speakingCountAfter).toBe(speakingCountBefore + 1);

      // Second chunk should NOT send another state_change:speaking
      resumeStreamCb.onChunk("base64audiodata2");
      const speakingCountAfter2 = ws.sentOfType("state_change")
        .filter((m: { state: string }) => m.state === "speaking").length;
      expect(speakingCountAfter2).toBe(speakingCountAfter);
    });

    it("voice resume ('devam et') sends qa_board_clear before resuming lesson", async () => {
      await startLesson();
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;

      // Barge-in during lesson
      ws.receiveJSON({ type: "barge_in" });

      // Q&A answer with board marker
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = 'Evet. \n---BOARD---\n[{"type":"text","text":"açıklama"}]';
          callbacks.onToken("Evet. ", "Evet. ");
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("Bu ne?", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalledTimes(initialOpenStreamCount + 1));

      // Q&A TTS ends → awaiting dismiss (board was sent)
      const qaStreamCb = mockTTS._openStreamCalls[initialOpenStreamCount];
      qaStreamCb.onEnd();

      // Voice resume instead of button dismiss
      const clearCountBefore = ws.sentOfType("qa_board_clear").length;
      mockSTT._startCb!.onTranscript("devam et", true);

      // qa_board_clear must be sent
      expect(ws.sentOfType("qa_board_clear").length).toBe(clearCountBefore + 1);

      // Lesson should resume (new TTS stream opened)
      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 2);
      });
    });

    it("Q&A without board auto-resumes lesson on TTS end (no dismiss needed)", async () => {
      await startLesson();
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;

      // Barge-in during lesson
      ws.receiveJSON({ type: "barge_in" });

      // Q&A answer WITHOUT board marker
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          callbacks.onToken("Tamam. ", "Tamam. ");
          callbacks.onDone("Tamam.");
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("3 artı 5 kaç eder", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalledTimes(initialOpenStreamCount + 1));

      await vi.waitFor(() => {
        expect(ws.sentOfType("state_change").at(-1)).toEqual({
          type: "state_change",
          state: "speaking",
        });
      });

      // Q&A TTS ends — no board was sent, so lesson should auto-resume
      const qaCb = mockTTS._openStreamCalls[initialOpenStreamCount];
      qaCb.onEnd();

      // awaitingOverlayDismiss should NOT be set — lesson auto-resumes
      // A new TTS stream should be opened for the resumed lesson
      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 2);
      });

      // No tts_end should have been sent (still in speaking state, resuming)
      // The session should still be in speaking state
      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "speaking",
      });

      // qa_overlay_dismiss should be a no-op since nothing is awaiting
      const clearCountBefore = ws.sentOfType("qa_board_clear").length;
      ws.receiveJSON({ type: "qa_overlay_dismiss" });
      expect(ws.sentOfType("qa_board_clear").length).toBe(clearCountBefore);
    });
  });

  // ── Board fallback ──

  describe("board drawing fallback", () => {
    it("triggers fallback when speech implies drawing but no marker present", async () => {
      ws.receiveJSON({ type: "start_listening" });

      // LLM responds with drawing intent but no ---BOARD--- marker
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = "Sana bir üçgen çizeyim, bak tahtada görebilirsin.";
          callbacks.onToken(text, text);
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("bir üçgen çiz", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Wait for fallback to fire
      await vi.waitFor(() => expect(mockLLM.generateBoardOnly).toHaveBeenCalled());

      // Should send qa_board_update from fallback
      await vi.waitFor(() => {
        expect(ws.sentOfType("qa_board_update")).toHaveLength(1);
      });
    });

    it("triggers fallback for 'çizerek' verb form (expanded regex)", async () => {
      ws.receiveJSON({ type: "start_listening" });

      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = "Young deneyinin temel prensibini tahtaya çizerek açıklıyorum.";
          callbacks.onToken(text, text);
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("Young deneyini çizerek anlat", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      await vi.waitFor(() => expect(mockLLM.generateBoardOnly).toHaveBeenCalled());

      await vi.waitFor(() => {
        expect(ws.sentOfType("qa_board_update")).toHaveLength(1);
      });
    });

    it("does not trigger fallback when speech has no drawing intent", async () => {
      ws.receiveJSON({ type: "start_listening" });

      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = "Merhaba, bugün toplama işlemini öğreneceğiz.";
          callbacks.onToken(text, text);
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("merhaba", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Give it a tick to ensure fallback would have fired if it was going to
      await new Promise(r => setTimeout(r, 10));
      expect(mockLLM.generateBoardOnly).not.toHaveBeenCalled();
    });

    it("does not trigger fallback when board marker is present", async () => {
      ws.receiveJSON({ type: "start_listening" });

      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = 'Sana bir üçgen çizeyim.\n---BOARD---\n[{"type":"text","text":"üçgen"}]';
          callbacks.onToken(text, text);
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("üçgen çiz", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Speculative board may fire from user input ("üçgen çiz" matches drawing pattern),
      // but inline board from marker should also be sent. Both are valid qa_board_update messages.
      await vi.waitFor(() => {
        const boardUpdates = ws.sentOfType("qa_board_update");
        expect(boardUpdates.length).toBeGreaterThanOrEqual(1);
        // The last board update should contain the inline board items from the marker
        const lastUpdate = boardUpdates[boardUpdates.length - 1] as { items: unknown[] };
        expect(lastUpdate.items).toEqual([{ type: "text", text: "üçgen" }]);
      });
    });

    it("swallows fallback errors without crashing", async () => {
      ws.receiveJSON({ type: "start_listening" });

      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = "Sana bir daire çizeyim.";
          callbacks.onToken(text, text);
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      (mockLLM.generateBoardOnly as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("API error"));

      mockSTT._startCb!.onTranscript("daire çiz", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      await vi.waitFor(() => expect(mockLLM.generateBoardOnly).toHaveBeenCalled());

      // No qa_board_update (fallback failed), no crash
      await new Promise(r => setTimeout(r, 10));
      expect(ws.sentOfType("qa_board_update")).toHaveLength(0);
      expect(ws.sentOfType("error")).toHaveLength(0);
    });
  });

  // ── Lesson resume timeout ──

  describe("lesson resume timeout", () => {
    const lessonItems = [
      { type: "heading", text: "Test Lesson", speech: "" },
      { type: "text", text: "Item 1", speech: "Speech for item one." },
      { type: "text", text: "Item 2", speech: "Speech for item two." },
      { type: "text", text: "Item 3", speech: "Speech for item three." },
    ];

    async function startLesson() {
      (mockLLM.generateLesson as ReturnType<typeof vi.fn>).mockResolvedValueOnce(lessonItems);
      ws.receiveJSON({ type: "generate_lesson", topic: "test" });
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());
    }

    it("auto-resumes lesson after barge-in when no transcript arrives (timeout)", async () => {
      await startLesson();
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;

      // Barge-in during lesson (noise / false positive)
      ws.receiveJSON({ type: "barge_in" });

      expect(ws.sentOfType("state_change").at(-1)).toEqual({
        type: "state_change",
        state: "listening",
      });

      // In test mode lessonResumeTimeoutMs=0, so timeout fires immediately on next tick
      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 1);
      });

      // Should have sent tts_start before resuming
      expect(ws.sentOfType("tts_start").length).toBeGreaterThanOrEqual(1);

      // STT should have been stopped
      expect(mockSTT.stop).toHaveBeenCalled();
    });

    it("cancels timeout when a real transcript arrives", async () => {
      await startLesson();
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;

      // Barge-in during lesson
      ws.receiveJSON({ type: "barge_in" });

      // User speaks a real question before timeout fires
      mockSTT._startCb!.onTranscript("Bu ne demek?", true);

      // LLM Q&A stream should open (not the timeout auto-resume)
      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 1);
      });

      // The Q&A LLM should have been called, not a direct resume
      expect(mockLLM.streamSpeechResponse).toHaveBeenCalled();
    });

    it("auto-resumes lesson after Q&A overlay dismiss timeout", async () => {
      await startLesson();
      const initialOpenStreamCount = mockTTS._openStreamCalls.length;

      // Barge-in during lesson
      ws.receiveJSON({ type: "barge_in" });

      // Q&A with board marker
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const text = 'Evet. \n---BOARD---\n[{"type":"text","text":"açıklama"}]';
          callbacks.onToken("Evet. ", "Evet. ");
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("Bu ne?", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalledTimes(initialOpenStreamCount + 1));

      // Q&A TTS ends → awaiting overlay dismiss
      const qaStreamCb = mockTTS._openStreamCalls[initialOpenStreamCount];
      qaStreamCb.onEnd();

      // In test mode timeout=0, so auto-resume fires immediately
      await vi.waitFor(() => {
        expect(mockTTS._openStreamCalls.length).toBe(initialOpenStreamCount + 2);
      });

      // qa_board_clear should have been sent by the timeout
      expect(ws.sentOfType("qa_board_clear").length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Drawing coordinate normalization ──

  describe("drawing coordinate normalization", () => {
    it("normalizes out-of-viewport polyline coordinates in Q&A board", async () => {
      ws.receiveJSON({ type: "start_listening" });

      // Pro model returns drawing with out-of-viewport coordinates
      const proDrawing = {
        type: "drawing",
        steps: [{
          shapes: [{
            type: "polyline",
            points: [[0, 0], [500, 0], [500, 400], [0, 400]] as [number, number][],
            stroke: "#000",
          }],
          speech: "A wave",
        }],
      };
      (mockLLM.generateBoardOnly as ReturnType<typeof vi.fn>).mockResolvedValueOnce([proDrawing]);

      // LLM responds with board containing out-of-viewport polyline (inline)
      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const boardJson = JSON.stringify([{
            type: "drawing",
            steps: [{
              shapes: [{
                type: "polyline",
                points: [[0, 0], [500, 0], [500, 400], [0, 400]],
                stroke: "#000",
              }],
              speech: "A wave",
            }],
          }]);
          const text = `Bak çiziyorum.\n---BOARD---\n${boardJson}`;
          callbacks.onToken("Bak çiziyorum. ", "Bak çiziyorum. ");
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("bir dalga çiz", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Wait for pro model board update (inline drawings are deferred to pro model)
      await vi.waitFor(() => {
        const updates = ws.sentOfType("qa_board_update");
        expect(updates.some((u: { items: Array<{ type: string }> }) => u.items.some(i => i.type === "drawing"))).toBe(true);
      });

      const updates = ws.sentOfType("qa_board_update");
      const boardUpdate = updates.find((u: { items: Array<{ type: string }> }) => u.items.some(i => i.type === "drawing"))!;
      const drawing = boardUpdate.items.find((i: { type: string }) => i.type === "drawing");
      expect(drawing.type).toBe("drawing");

      // All points should be within viewport (0-400 x 0-300)
      for (const step of drawing.steps) {
        for (const shape of step.shapes) {
          if (shape.type === "polyline") {
            for (const [x, y] of shape.points) {
              expect(x).toBeGreaterThanOrEqual(0);
              expect(x).toBeLessThanOrEqual(400);
              expect(y).toBeGreaterThanOrEqual(0);
              expect(y).toBeLessThanOrEqual(300);
            }
          }
        }
      }
    });

    it("does not modify coordinates already within viewport", async () => {
      ws.receiveJSON({ type: "start_listening" });

      const originalPoints: [number, number][] = [[50, 50], [200, 100], [350, 250]];

      // Pro model returns drawing with in-viewport coordinates
      const proDrawing = {
        type: "drawing",
        steps: [{
          shapes: [{
            type: "polyline",
            points: [...originalPoints.map(p => [...p])] as [number, number][],
            stroke: "#000",
          }],
          speech: "A line",
        }],
      };
      (mockLLM.generateBoardOnly as ReturnType<typeof vi.fn>).mockResolvedValueOnce([proDrawing]);

      (mockLLM.streamSpeechResponse as ReturnType<typeof vi.fn>).mockImplementationOnce(function (
        this: MockLLM,
        _transcript: string,
        _history: unknown,
        callbacks: LLMStreamCallbacks,
      ) {
        this._streamCb = callbacks;
        queueMicrotask(() => {
          const boardJson = JSON.stringify([{
            type: "drawing",
            steps: [{
              shapes: [{
                type: "polyline",
                points: originalPoints,
                stroke: "#000",
              }],
              speech: "A line",
            }],
          }]);
          const text = `Bak çiziyorum.\n---BOARD---\n${boardJson}`;
          callbacks.onToken("Bak çiziyorum. ", "Bak çiziyorum. ");
          callbacks.onDone(text);
        });
        return { abort: this._abortFn };
      });

      mockSTT._startCb!.onTranscript("bir çizgi çiz", true);
      await vi.waitFor(() => expect(mockTTS.openStream).toHaveBeenCalled());

      // Wait for pro model board update
      await vi.waitFor(() => {
        const updates = ws.sentOfType("qa_board_update");
        expect(updates.some((u: { items: Array<{ type: string }> }) => u.items.some(i => i.type === "drawing"))).toBe(true);
      });

      const updates = ws.sentOfType("qa_board_update");
      const boardUpdate = updates.find((u: { items: Array<{ type: string }> }) => u.items.some(i => i.type === "drawing"))!;
      const drawing = boardUpdate.items.find((i: { type: string }) => i.type === "drawing");
      const points = drawing.steps[0].shapes[0].points;

      // Points should remain unchanged since they were already within viewport
      expect(points[0]).toEqual([50, 50]);
      expect(points[1]).toEqual([200, 100]);
      expect(points[2]).toEqual([350, 250]);
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
