import Anthropic from '@anthropic-ai/sdk';
import type { BoardItem } from '@myteacher/shared';
import { parseBoardItems } from '../utils/llm-output.js';
import { createGeminiLLMService } from './gemini.js';

/** LLM service — real Anthropic API for speech responses, placeholder for board generation */

export interface LLMStreamCallbacks {
  onToken(delta: string, snapshot: string): void;
  onDone(fullText: string): void;
  onError(err: Error): void;
}

export interface LLMStreamHandle {
  abort(): void;
}

export interface LLMService {
  generateLesson(topic: string): Promise<BoardItem[]>;
  generateSpeechResponse(transcript: string): Promise<string>;
  streamSpeechResponse(transcript: string, callbacks: LLMStreamCallbacks): LLMStreamHandle;
  answerAnnotation(
    boardItems: BoardItem[],
    clickedIndex: number,
    question: string,
  ): Promise<string>;
}

export const PLACEHOLDER_BOARD: BoardItem[] = [
  { type: 'title', text: 'Toplama İşlemi' },
  { type: 'text', text: 'Toplama, iki veya daha fazla sayıyı birleştirme işlemidir.' },
  { type: 'formula', text: '3 + 5 = 8\n12 + 7 = 19' },
  { type: 'list', items: ['Toplanan sayılara "toplanan" denir', 'Sonuca "toplam" denir', 'Toplama sırası değiştirilebilir'] },
  { type: 'highlight', text: 'Hatırla: Toplama işleminde sıra fark etmez! 3 + 5 = 5 + 3' },
];

const PLACEHOLDER_RAW_JSON = JSON.stringify(PLACEHOLDER_BOARD);

export const SPEECH_SYSTEM_PROMPT = `Sen "Öğretmenim" adında, ilkokul çağındaki çocuklara Türkçe ders anlatan sıcak ve sabırlı bir öğretmensin.

Kurallar:
- Kısa ve net cevaplar ver (2-3 cümle).
- Çocuklara uygun, basit bir dil kullan.
- Teşvik edici ve pozitif ol.
- Sadece düz metin olarak yanıt ver, markdown veya özel format kullanma.
- Sayıları rakamla yaz (5, 10 gibi), yazıyla değil.`;

function createClaudeLLMService(): LLMService {
  const client = new Anthropic();

  return {
    async generateLesson(topic: string): Promise<BoardItem[]> {
      console.log(`[llm:claude] generating lesson for: ${topic} (placeholder)`);

      // Placeholder — will be real in Dilim 3
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const items = parseBoardItems(PLACEHOLDER_RAW_JSON);
          return items;
        } catch (err) {
          console.warn(`[llm:claude] attempt ${attempt + 1} failed:`, err);
          if (attempt === 1) throw err;
        }
      }

      throw new Error('unreachable');
    },

    async generateSpeechResponse(transcript: string): Promise<string> {
      console.log(`[llm:claude] generating speech response for: "${transcript.slice(0, 60)}..."`);

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: SPEECH_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: transcript },
        ],
      });

      const block = response.content[0];
      if (block.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }
      return block.text;
    },

    streamSpeechResponse(transcript: string, callbacks: LLMStreamCallbacks): LLMStreamHandle {
      console.log(`[llm:claude] streaming speech response for: "${transcript.slice(0, 60)}..."`);

      const stream = client.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: SPEECH_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: transcript },
        ],
      });

      let snapshot = '';

      stream.on('text', (delta) => {
        snapshot += delta;
        callbacks.onToken(delta, snapshot);
      });

      stream.on('end', () => {
        callbacks.onDone(snapshot);
      });

      stream.on('error', (err) => {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      });

      return { abort: () => stream.abort() };
    },

    async answerAnnotation(
      boardItems: BoardItem[],
      clickedIndex: number,
      question: string,
    ): Promise<string> {
      console.log(`[llm:claude] annotation click index=${clickedIndex}, question="${question}" (placeholder)`);

      // Placeholder — will be real in Dilim 3
      const q = question || 'Bu ne demek?';
      const clicked = boardItems[clickedIndex];
      const clickedText = clicked.type === 'list' ? clicked.items.join(', ') : clicked.text;

      return `"${clickedText}" hakkında: ${q} — Bu konu şu anlama gelir: ${clickedText} ifadesi temel bir kavramdır.`;
    },
  };
}

export function createLLMService(): LLMService {
  const provider = process.env.LLM_PROVIDER ?? 'google';

  if (provider === 'anthropic') {
    console.log('[llm] Using Anthropic Claude provider');
    return createClaudeLLMService();
  }

  console.log('[llm] Using Google Gemini provider');
  return createGeminiLLMService();
}
