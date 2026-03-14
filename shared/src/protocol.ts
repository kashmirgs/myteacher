// ── Drawing Primitives ──

export type Shape =
  | { type: "line"; x1: number; y1: number; x2: number; y2: number;
      stroke?: string; strokeWidth?: number; dashed?: boolean }
  | { type: "circle"; cx: number; cy: number; r: number;
      stroke?: string; fill?: string; strokeWidth?: number }
  | { type: "arc"; cx: number; cy: number; r: number;
      startAngle: number; endAngle: number;
      fill?: string; stroke?: string; strokeWidth?: number }
  | { type: "rect"; x: number; y: number; width: number; height: number;
      fill?: string; stroke?: string; strokeWidth?: number }
  | { type: "text"; x: number; y: number; text: string;
      fontSize?: number; fill?: string; anchor?: "start" | "middle" | "end" }
  | { type: "point"; cx: number; cy: number; r?: number;
      fill?: string; label?: string; labelDir?: "top" | "right" | "bottom" | "left" }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number;
      stroke?: string; strokeWidth?: number }
  | { type: "polygon"; points: [number, number][];
      fill?: string; stroke?: string; strokeWidth?: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number;
      fill?: string; stroke?: string; strokeWidth?: number };

export type CoordSystem = {
  xMin: number; xMax: number;
  yMin: number; yMax: number;
  showAxes?: boolean;
  showGrid?: boolean;
  gridStep?: number;
  xLabel?: string;
  yLabel?: string;
};

export type DrawingStep = {
  shapes: Shape[];
  speech: string;
};

// ── Board Items (from LESSONS.md Test 4 learnings) ──

export type BoardItem =
  | { type: "title"; text: string }
  | { type: "text"; text: string }
  | { type: "formula"; text: string } // • delimiter → newline in renderer
  | { type: "list"; items: string[] }
  | { type: "highlight"; text: string }
  | { type: "drawing"; coordSystem?: CoordSystem; steps: DrawingStep[] };

export type BoardItemType = BoardItem["type"];

export const KNOWN_BOARD_TYPES: readonly BoardItemType[] = ["title", "text", "formula", "list", "highlight", "drawing"] as const;

// ── Lesson Topics (preset lessons) ──

export interface TopicSummary {
  id: string;
  title: string;
  description: string | null;
  gradeLevel: number;
  subject: string;
  isActive: boolean;
}

// ── Session State ──

export type SessionState = "idle" | "listening" | "processing" | "speaking";

// ── Client → Server Messages ──

export type ClientMessage =
  | { type: "audio_chunk"; data: string } // base64 audio
  | { type: "start_listening" }
  | { type: "stop_listening"; reason?: string; source?: string }
  | { type: "barge_in" }
  | { type: "annotation_click"; index: number; question: string }
  | { type: "generate_lesson"; topic: string }
  | { type: "start_preset_lesson"; topicId: string };

// ── Server → Client Messages ──

export type ServerMessage =
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "board_update"; items: BoardItem[] }
  | { type: "board_reveal"; index: number }
  | { type: "drawing_step"; itemIndex: number; stepIndex: number }
  | { type: "tts_chunk"; audio: string } // base64 audio
  | { type: "tts_start" }
  | { type: "tts_end" }
  | { type: "state_change"; state: SessionState }
  | { type: "error"; message: string };
