import Anthropic from '@anthropic-ai/sdk';
import type { BoardItem } from '@myteacher/shared';
import { parseBoardItems } from '../utils/llm-output.js';
import { createGeminiLLMService } from './gemini.js';

/** LLM service — real Anthropic API for speech responses, placeholder for board generation */

export type LessonBoardItem = BoardItem & { speech?: string };

export interface LLMStreamCallbacks {
  onToken(delta: string, snapshot: string): void;
  onDone(fullText: string): void;
  onError(err: Error): void;
}

export interface LLMStreamHandle {
  abort(): void;
}

export interface LLMService {
  generateLesson(topic: string): Promise<LessonBoardItem[]>;
  generateSpeechResponse(transcript: string): Promise<string>;
  streamSpeechResponse(transcript: string, callbacks: LLMStreamCallbacks): LLMStreamHandle;
  answerAnnotation(
    boardItems: BoardItem[],
    clickedIndex: number,
    question: string,
  ): Promise<string>;
}


export const SPEECH_SYSTEM_PROMPT = `Sen "Öğretmenim" adında, ilkokul çağındaki çocuklara Türkçe ders anlatan sıcak ve sabırlı bir öğretmensin.

Kurallar:
- Kısa ve net cevaplar ver (2-3 cümle).
- Çocuklara uygun, basit bir dil kullan.
- Teşvik edici ve pozitif ol.
- Sadece düz metin olarak yanıt ver, markdown veya özel format kullanma.
- Sayıları rakamla yaz (5, 10 gibi), yazıyla değil.`;

export const LESSON_SYSTEM_PROMPT = 'Sen ilkokul öğretmenisin. Sadece istenen JSON formatında yanıt ver.\nHer eleman için "speech" alanına o elemanın sesli anlatımını yaz (1-2 cümle, konuşma dili).';

export function buildLessonPrompt(topic: string): string {
  return `Konu: ${topic}

Aşağıdaki JSON formatında bir ders tahtası oluştur. 5-10 arası eleman üret. İlk eleman mutlaka "title" olsun. En az 2 farklı tip kullan.

Örnek format:
[
  { "type": "title", "text": "Ders Başlığı", "speech": "Merhaba çocuklar! Bugün ders başlığı konusunu öğreneceğiz." },
  { "type": "text", "text": "Açıklama metni.", "speech": "Şimdi size açıklama metnini anlatayım." },
  { "type": "formula", "text": "3 + 5 = 8", "speech": "Bakın, 3 ile 5'i toplarsak 8 eder." },
  { "type": "list", "items": ["Madde 1", "Madde 2", "Madde 3"], "speech": "Şimdi maddelerimize bakalım." },
  { "type": "highlight", "text": "Önemli not!", "speech": "Bunu mutlaka hatırlayın çocuklar!" }
]

Kurallar:
- Sadece JSON dizisi döndür, başka hiçbir şey yazma.
- Geçerli tipler: title, text, formula, list, highlight
- İlkokul seviyesinde, Türkçe açıkla.
- Sayıları rakamla yaz (5, 10 gibi).
- Formüllerde çok satır varsa • ile ayır.
- speech: o item gösterilirken sesli söylenecek metin (1-2 cümle, doğal konuşma dili Türkçe). Her item'da speech olmalı.`;
}

export const ANNOTATION_SYSTEM_PROMPT = `Sen ilkokul öğretmenisin. Öğrenci tahtadaki bir öğeye tıklayıp soru sordu.
Kurallar:
- 1-3 cümle ile yanıtla.
- Yanıtında tıklanan elemanın içindeki ifadeyi aynen tekrarla.
- Sayıları rakamla yaz.
- Çocuklara uygun, basit dil kullan.`;

export function buildAnnotationContext(boardItems: BoardItem[], clickedIndex: number): string {
  return boardItems.map((item, i) => {
    const marker = i === clickedIndex ? ' ← İŞARETLENDİ' : '';
    if (item.type === 'list') return `[${i}] (${item.type}) ${item.items.join(', ')}${marker}`;
    return `[${i}] (${item.type}) ${item.text}${marker}`;
  }).join('\n');
}

function createClaudeLLMService(): LLMService {
  const client = new Anthropic();

  return {
    async generateLesson(topic: string): Promise<LessonBoardItem[]> {
      console.log(`[llm:claude] generating lesson for: ${topic}`);

      const prompt = buildLessonPrompt(topic);

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: LESSON_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
          });
          const block = response.content[0];
          if (block.type !== 'text') throw new Error('Unexpected response type');
          return parseBoardItems(block.text) as LessonBoardItem[];
        } catch (err) {
          console.warn(`[llm:claude] generateLesson attempt ${attempt + 1} failed:`, err);
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
      console.log(`[llm:claude] annotation click index=${clickedIndex}, question="${question}"`);

      const boardContext = buildAnnotationContext(boardItems, clickedIndex);
      const q = question || 'Bu ne demek?';

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: ANNOTATION_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Tahta içeriği:\n${boardContext}\n\nSoru: ${q}`,
        }],
      });
      const block = response.content[0];
      if (block.type !== 'text') throw new Error('Unexpected response type');
      return block.text;
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
