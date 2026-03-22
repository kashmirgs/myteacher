import { GoogleGenAI } from "@google/genai";
import type { BoardItem } from "@myteacher/shared";
import { parseBoardItems, parseLLMJson } from "../utils/llm-output.js";
import type { LLMService, LLMStreamCallbacks, LLMStreamHandle, LessonBoardItem, LessonLength, QuestionOptions } from "./claude.js";
import {
  buildSpeechSystemPrompt,
  buildAnnotationSystemPrompt,
  BOARD_ONLY_SYSTEM_PROMPT,
  buildLessonPrompt,
  buildLessonSystemPrompt,
  buildAnnotationContext,
} from "./claude.js";
import type { ConversationHistory } from "./conversation.js";

export function createGeminiLLMService(): LLMService {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is missing. Set it or use LLM_PROVIDER=mock.");
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

  return {
    async generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions): Promise<LessonBoardItem[]> {
      console.log(`[llm:gemini] generating lesson for: ${topic} (grade ${gradeLevel ?? "default"}, length ${length ?? "default"})`);

      const prompt = buildLessonPrompt(topic, gradeLevel, length, questionOpts);
      const systemPrompt = buildLessonSystemPrompt(gradeLevel, length);

      // Try pro model first, fall back to flash-lite on failure
      const models = ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"] as const;
      for (const model of models) {
        try {
          console.log(`[llm:gemini] trying model: ${model}`);
          const response = await ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              systemInstruction: systemPrompt,
              maxOutputTokens: 20000,
            },
          });
          return parseBoardItems(response.text ?? "") as LessonBoardItem[];
        } catch (err) {
          console.warn(`[llm:gemini] generateLesson with ${model} failed:`, err);
          if (model === models[models.length - 1]) throw err;
        }
      }

      throw new Error("unreachable");
    },

    async generateSpeechResponse(transcript: string): Promise<string> {
      console.log(`[llm:gemini] generating speech response for: "${transcript.slice(0, 60)}..."`);

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: [{ role: "user", parts: [{ text: transcript }] }],
        config: { systemInstruction: buildSpeechSystemPrompt(), maxOutputTokens: 512 },
      });

      return response.text ?? "";
    },

    streamSpeechResponse(
      transcript: string,
      history: ConversationHistory,
      callbacks: LLMStreamCallbacks,
      gradeLevel?: number,
    ): LLMStreamHandle {
      console.log(`[llm:gemini] streaming speech response for: "${transcript.slice(0, 60)}..."`);

      const controller = new AbortController();

      (async () => {
        try {
          const response = await ai.models.generateContentStream({
            model: "gemini-3.1-flash-lite-preview",
            contents: history.getMessagesForGemini(),
            config: {
              systemInstruction: buildSpeechSystemPrompt(gradeLevel),
              maxOutputTokens: 1024,
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

    async answerAnnotation(
      boardItems: BoardItem[],
      clickedIndex: number,
      question: string,
      history: ConversationHistory,
      gradeLevel?: number,
    ): Promise<string> {
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
          systemInstruction: buildAnnotationSystemPrompt(gradeLevel),
          maxOutputTokens: 512,
        },
      });
      return response.text ?? "";
    },

    async generateBoardOnly(speechText: string, history: ConversationHistory): Promise<BoardItem[]> {
      console.log(`[llm:gemini] generateBoardOnly for: "${speechText.slice(0, 60)}..."`);

      const contents = [
        ...history.getMessagesForGemini(),
        { role: "user" as const, parts: [{ text: `Konuşma metni: ${speechText}` }] },
      ];

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents,
        config: {
          systemInstruction: BOARD_ONLY_SYSTEM_PROMPT,
          maxOutputTokens: 2048,
        },
      });
      const text = response.text ?? "";
      const items = parseLLMJson(text);
      if (!Array.isArray(items)) throw new Error("Expected JSON array");
      return items as BoardItem[];
    },
  };
}
