// ── Board Items (from LESSONS.md Test 4 learnings) ──

export type BoardItem =
  | { type: "title"; text: string }
  | { type: "text"; text: string }
  | { type: "formula"; text: string } // • delimiter → newline in renderer
  | { type: "list"; items: string[] }
  | { type: "highlight"; text: string };

export type BoardItemType = BoardItem["type"];

export const KNOWN_BOARD_TYPES: readonly BoardItemType[] = ["title", "text", "formula", "list", "highlight"] as const;

// ── Session State ──

export type SessionState = "idle" | "listening" | "processing" | "speaking";

// ── Client → Server Messages ──

export type ClientMessage =
  | { type: "audio_chunk"; data: string } // base64 audio
  | { type: "start_listening" }
  | { type: "stop_listening"; reason?: string; source?: string }
  | { type: "barge_in" }
  | { type: "annotation_click"; index: number; question: string };

// ── Server → Client Messages ──

export type ServerMessage =
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "board_update"; items: BoardItem[] }
  | { type: "tts_chunk"; audio: string } // base64 audio
  | { type: "tts_start" }
  | { type: "tts_end" }
  | { type: "state_change"; state: SessionState }
  | { type: "error"; message: string };
