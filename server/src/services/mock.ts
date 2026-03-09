import type { BoardItem } from "@myteacher/shared";
import type { LLMService, LLMStreamCallbacks, LLMStreamHandle, LessonBoardItem } from "./claude.js";
import type { ConversationHistory } from "./conversation.js";

function buildMockLesson(topic: string): LessonBoardItem[] {
  return [
    {
      type: "title",
      text: `${topic} Dersi`,
      speech: `Merhaba! Bugün ${topic} konusunu öğreneceğiz.`,
    },
    {
      type: "text",
      text: `${topic} bir kelimeyi ya da fikri anlatmak için kullanılır.`,
      speech: `${topic} bir kelimeyi ya da fikri anlatmak için kullanılır.`,
    },
    {
      type: "list",
      items: [`${topic} örneği 1`, `${topic} örneği 2`, `${topic} örneği 3`],
      speech: `Şimdi ${topic} ile ilgili birkaç örnek görelim.`,
    },
    {
      type: "highlight",
      text: `${topic} günlük konuşmada çok kullanılır.`,
      speech: `${topic} günlük konuşmada çok kullanılır, buna dikkat edelim.`,
    },
  ];
}

function buildMockSpeechResponse(transcript: string): string {
  return `Bunu şöyle düşünebilirsin: ${transcript}. Kısa bir örnekle tekrar edelim.`;
}

function buildMockAnnotationAnswer(item: BoardItem, question: string): string {
  if (item.type === "list") {
    const entry = item.items[0] ?? "bu örnek";
    return `${entry} örneği, ${question.toLowerCase()} için basit bir açıklamadır.`;
  }
  return `${item.text} ifadesi, ${question.toLowerCase()} için basit bir açıklamadır.`;
}

export function createMockLLMService(): LLMService {
  return {
    async generateLesson(topic: string): Promise<LessonBoardItem[]> {
      console.log(`[llm:mock] generating lesson for: ${topic}`);
      return buildMockLesson(topic);
    },

    async generateSpeechResponse(transcript: string): Promise<string> {
      console.log(`[llm:mock] generating speech response for: "${transcript.slice(0, 60)}..."`);
      return buildMockSpeechResponse(transcript);
    },

    streamSpeechResponse(
      transcript: string,
      _history: ConversationHistory,
      callbacks: LLMStreamCallbacks,
    ): LLMStreamHandle {
      console.log(`[llm:mock] streaming speech response for: "${transcript.slice(0, 60)}..."`);
      let cancelled = false;
      const response = buildMockSpeechResponse(transcript);
      setTimeout(() => {
        if (cancelled) return;
        callbacks.onToken(response, response);
        callbacks.onDone(response);
      }, 0);
      return {
        abort: () => {
          cancelled = true;
        },
      };
    },

    async answerAnnotation(
      boardItems: BoardItem[],
      clickedIndex: number,
      question: string,
      _history: ConversationHistory,
    ): Promise<string> {
      console.log(`[llm:mock] annotation click index=${clickedIndex}, question="${question}"`);
      const item = boardItems[clickedIndex];
      return buildMockAnnotationAnswer(item, question || "Bu ne demek?");
    },
  };
}
