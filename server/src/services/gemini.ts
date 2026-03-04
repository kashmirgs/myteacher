import { GoogleGenAI } from "@google/genai";
import type { BoardItem } from "@myteacher/shared";
import { parseBoardItems } from "../utils/llm-output.js";
import type { LLMService, LLMStreamCallbacks, LLMStreamHandle } from "./claude.js";
import { SPEECH_SYSTEM_PROMPT, PLACEHOLDER_BOARD } from "./claude.js";

export function createGeminiLLMService(): LLMService {
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const PLACEHOLDER_RAW_JSON = JSON.stringify(PLACEHOLDER_BOARD);

  return {
    async generateLesson(topic: string): Promise<BoardItem[]> {
      console.log(`[llm:gemini] generating lesson for: ${topic} (placeholder)`);

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const items = parseBoardItems(PLACEHOLDER_RAW_JSON);
          return items;
        } catch (err) {
          console.warn(`[llm:gemini] attempt ${attempt + 1} failed:`, err);
          if (attempt === 1) throw err;
        }
      }

      throw new Error("unreachable");
    },

    async generateSpeechResponse(transcript: string): Promise<string> {
      console.log(`[llm:gemini] generating speech response for: "${transcript.slice(0, 60)}..."`);

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: [{ role: "user", parts: [{ text: transcript }] }],
        config: { systemInstruction: SPEECH_SYSTEM_PROMPT, maxOutputTokens: 512 },
      });

      return response.text ?? "";
    },

    streamSpeechResponse(transcript: string, callbacks: LLMStreamCallbacks): LLMStreamHandle {
      console.log(`[llm:gemini] streaming speech response for: "${transcript.slice(0, 60)}..."`);

      const controller = new AbortController();

      (async () => {
        try {
          const response = await ai.models.generateContentStream({
            model: "gemini-3.1-flash-lite-preview",
            contents: [{ role: "user", parts: [{ text: transcript }] }],
            config: {
              systemInstruction: SPEECH_SYSTEM_PROMPT,
              maxOutputTokens: 512,
              abortSignal: controller.signal,
            },
          });

          let snapshot = "";
          for await (const chunk of response) {
            if (controller.signal.aborted) return;
            const delta = chunk.text ?? "";
            snapshot += delta;
            callbacks.onToken(delta, snapshot);
          }
          if (controller.signal.aborted) return;
          callbacks.onDone(snapshot);
        } catch (err) {
          if (controller.signal.aborted) return;
          callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return { abort: () => controller.abort() };
    },

    async answerAnnotation(boardItems: BoardItem[], clickedIndex: number, question: string): Promise<string> {
      console.log(`[llm:gemini] annotation click index=${clickedIndex}, question="${question}" (placeholder)`);

      const q = question || "Bu ne demek?";
      const clicked = boardItems[clickedIndex];
      const clickedText = clicked.type === "list" ? clicked.items.join(", ") : clicked.text;

      return `"${clickedText}" hakkında: ${q} — Bu konu şu anlama gelir: ${clickedText} ifadesi temel bir kavramdır.`;
    },
  };
}
