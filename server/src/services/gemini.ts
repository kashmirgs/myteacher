import { GoogleGenAI } from "@google/genai";
import type { BoardItem } from "@myteacher/shared";
import { parseBoardItems } from "../utils/llm-output.js";
import type { LLMService, LLMStreamCallbacks, LLMStreamHandle, LessonBoardItem } from "./claude.js";
import {
  SPEECH_SYSTEM_PROMPT,
  LESSON_SYSTEM_PROMPT,
  ANNOTATION_SYSTEM_PROMPT,
  buildLessonPrompt,
  buildAnnotationContext,
} from "./claude.js";
import type { ConversationHistory } from "./conversation.js";

export function createGeminiLLMService(): LLMService {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is missing. Set it or use LLM_PROVIDER=mock.');
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

  return {
    async generateLesson(topic: string): Promise<LessonBoardItem[]> {
      console.log(`[llm:gemini] generating lesson for: ${topic}`);

      const prompt = buildLessonPrompt(topic);

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-lite-preview",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              systemInstruction: LESSON_SYSTEM_PROMPT,
              maxOutputTokens: 2048,
            },
          });
          return parseBoardItems(response.text ?? "") as LessonBoardItem[];
        } catch (err) {
          console.warn(`[llm:gemini] generateLesson attempt ${attempt + 1} failed:`, err);
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

    streamSpeechResponse(transcript: string, history: ConversationHistory, callbacks: LLMStreamCallbacks): LLMStreamHandle {
      console.log(`[llm:gemini] streaming speech response for: "${transcript.slice(0, 60)}..."`);

      const controller = new AbortController();

      (async () => {
        try {
          const response = await ai.models.generateContentStream({
            model: "gemini-3.1-flash-lite-preview",
            contents: history.getMessagesForGemini(),
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

    async answerAnnotation(boardItems: BoardItem[], clickedIndex: number, question: string, history: ConversationHistory): Promise<string> {
      console.log(`[llm:gemini] annotation click index=${clickedIndex}, question="${question}"`);

      const boardContext = buildAnnotationContext(boardItems, clickedIndex);
      const q = question || "Bu ne demek?";

      const contents = [
        ...history.getMessagesForGemini(),
        { role: "user" as const, parts: [{ text: `Tahta içeriği:\n${boardContext}\n\nSoru: ${q}` }] },
      ];

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents,
        config: {
          systemInstruction: ANNOTATION_SYSTEM_PROMPT,
          maxOutputTokens: 512,
        },
      });
      return response.text ?? "";
    },
  };
}
