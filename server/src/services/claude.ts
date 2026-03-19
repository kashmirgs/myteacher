import Anthropic from "@anthropic-ai/sdk";
import type { BoardItem } from "@myteacher/shared";
import { parseBoardItems } from "../utils/llm-output.js";
import { createGeminiLLMService } from "./gemini.js";
import { createMockLLMService } from "./mock.js";
import type { ConversationHistory } from "./conversation.js";

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

export interface QuestionOptions {
  includeQuestions?: boolean;
  examStyle?: boolean;
}

export interface LLMService {
  generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions): Promise<LessonBoardItem[]>;
  generateSpeechResponse(transcript: string): Promise<string>;
  streamSpeechResponse(
    transcript: string,
    history: ConversationHistory,
    callbacks: LLMStreamCallbacks,
  ): LLMStreamHandle;
  answerAnnotation(
    boardItems: BoardItem[],
    clickedIndex: number,
    question: string,
    history: ConversationHistory,
  ): Promise<string>;
}

function createFallbackLLMService(primary: LLMService, fallback: LLMService): LLMService {
  return {
    async generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions): Promise<LessonBoardItem[]> {
      try {
        return await primary.generateLesson(topic, gradeLevel, length, questionOpts);
      } catch (err) {
        console.warn("[llm] primary generateLesson failed, using fallback:", err);
        return fallback.generateLesson(topic, gradeLevel, length, questionOpts);
      }
    },

    async generateSpeechResponse(transcript: string): Promise<string> {
      try {
        return await primary.generateSpeechResponse(transcript);
      } catch (err) {
        console.warn("[llm] primary generateSpeechResponse failed, using fallback:", err);
        return fallback.generateSpeechResponse(transcript);
      }
    },

    streamSpeechResponse(
      transcript: string,
      history: ConversationHistory,
      callbacks: LLMStreamCallbacks,
    ): LLMStreamHandle {
      let fallbackHandle: LLMStreamHandle | null = null;
      const handle = primary.streamSpeechResponse(transcript, history, {
        onToken: callbacks.onToken,
        onDone: callbacks.onDone,
        onError: (err) => {
          console.warn("[llm] primary streamSpeechResponse failed, using fallback:", err);
          fallbackHandle = fallback.streamSpeechResponse(transcript, history, callbacks);
        },
      });

      return {
        abort: () => {
          handle.abort();
          fallbackHandle?.abort();
        },
      };
    },

    async answerAnnotation(
      boardItems: BoardItem[],
      clickedIndex: number,
      question: string,
      history: ConversationHistory,
    ): Promise<string> {
      try {
        return await primary.answerAnnotation(boardItems, clickedIndex, question, history);
      } catch (err) {
        console.warn("[llm] primary answerAnnotation failed, using fallback:", err);
        return fallback.answerAnnotation(boardItems, clickedIndex, question, history);
      }
    },
  };
}

export const SPEECH_SYSTEM_PROMPT = `Sen "Öğretmenim" adında, ilkokul çağındaki çocuklara Türkçe ders anlatan sıcak ve sabırlı bir öğretmensin.

Kurallar:
- Kısa ve net cevaplar ver (2-3 cümle).
- Çocuklara uygun, basit bir dil kullan.
- Teşvik edici ve pozitif ol.
- Sadece düz metin olarak yanıt ver, markdown veya özel format kullanma.
- Sayıları rakamla yaz (5, 10 gibi), yazıyla değil.
- Her seferinde yeniden tanışma veya merhaba deme. Sohbet devam ediyorsa doğrudan konuya gir.
- Önceki konuşmalardaki bilgileri hatırla ve tutarlı ol. Aynı şeyleri tekrarlama.
- Tahtada bir ders varsa, öğrencinin soruları o dersle ilgili olabilir.`;

export type LessonLength = "short" | "medium" | "long";

const LESSON_LENGTH_CONFIG: Record<LessonLength, { items: string; speechLen: string }> = {
  short:  { items: "5-7 arası",  speechLen: "1-2 cümle" },
  medium: { items: "8-12 arası", speechLen: "2-3 cümle" },
  long:   { items: "13-18 arası", speechLen: "3-4 cümle" },
};

function buildLessonSystemPrompt(gradeLevel?: number, length?: LessonLength): string {
  const level = gradeLevel ?? 1;
  const cfg = LESSON_LENGTH_CONFIG[length ?? "short"];
  let schoolType: string;
  let tone: string;
  if (level <= 4) {
    schoolType = "ilkokul";
    tone = "Çocuklara uygun, basit ve eğlenceli bir dil kullan.";
  } else if (level <= 8) {
    schoolType = "ortaokul";
    tone = "Öğrencilere uygun, açık ve anlaşılır bir dil kullan.";
  } else {
    schoolType = "lise";
    tone = "Lise öğrencilerine uygun, akademik ama anlaşılır bir dil kullan.";
  }
  return `Sen ${level}. sınıf (${schoolType}) öğretmenisin. Sadece istenen JSON formatında yanıt ver.\nHer eleman için "speech" alanına o elemanın sesli anlatımını yaz (${cfg.speechLen}, konuşma dili).\n${tone}`;
}

// Default for WS lesson generation (no grade level info)
export const LESSON_SYSTEM_PROMPT = buildLessonSystemPrompt(1);

export function buildLessonPrompt(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions): string {
  const level = gradeLevel ?? 1;
  const cfg = LESSON_LENGTH_CONFIG[length ?? "short"];
  let schoolType: string;
  if (level <= 4) schoolType = "ilkokul";
  else if (level <= 8) schoolType = "ortaokul";
  else schoolType = "lise";

  let questionPrompt = "";
  if (questionOpts?.includeQuestions) {
    questionPrompt = `
- question tipi: Konuyu anlattıktan sonra araya soru ekle. 4 şık (A-D), tek doğru cevap.
  Format: { "type": "question", "text": "Soru?", "options": ["A şıkkı", "B şıkkı", "C şıkkı", "D şıkkı"], "correct": 0, "explanation": "Kısa açıklama.", "speech": "Şimdi bir soru sorayım. [soruyu oku]. Hadi birlikte çözelim." }
  correct: 0-tabanlı indeks (0=A, 1=B, 2=C, 3=D).
  Toplam elemanların ~%20-25'i question olsun. Her soru, o konuyu anlatan bölümden sonra gelsin.
  ÖNEMLİ — Kapsam: Soru, dersin ilerleyen bölümlerinde anlatılacak kavramları içermesin. Ancak öğrencinin önceden bilmesi gereken farklı konulardaki ön bilgiler soruda kullanılabilir. Örneğin trigonometri dersinde henüz sadece sin ve cos anlatıldıysa, dersin devamında anlatılacak tan'ı sorma; ama daha önce öğrenilmiş temel aritmetik veya geometri bilgisi soruda yer alabilir.
  ÖNEMLİ — Görsel çözüm: Her question'dan hemen sonra bir drawing item koy ve çözümü tahtada adım adım göster.
  Question speech'i sadece soruyu okusun ve "Hadi birlikte çözelim" gibi bir geçiş cümlesi söylesin.
  Çözüm drawing'inin her step'inde çözümün bir adımını shapes ile tahtaya çiz ve speech ile açıkla.
  Son step'te doğru cevabı vurgula (örn: yeşil renkle doğru şıkkı yaz).
  Örnek sıralama: question → drawing (çözüm adımları) → sonraki konu...`;

    if (questionOpts.examStyle) {
      if (level >= 5 && level <= 8) {
        questionPrompt += `\n  Sorular LGS (Liseye Geçiş Sınavı) formatında olsun: paragraf yorumlama, çok adımlı problem çözme, analiz ve değerlendirme gerektiren sorular. Gerçek LGS sınavlarındaki soru tarzını ve zorluğunu yakala.`;
      } else if (level >= 9) {
        questionPrompt += `\n  Sorular YKS/AYT formatında olsun: kavramsal derinlik, analitik düşünme, çeldirici şıklar. Üniversite giriş sınavı tarzı ve zorluğunda sorular üret.`;
      }
    }
  }

  const questionExample = questionOpts?.includeQuestions
    ? `,
  { "type": "question", "text": "3 + 5 kaç eder?", "options": ["6", "7", "8", "9"], "correct": 2, "explanation": "3 ile 5'i toplarsak 8 eder.", "speech": "Şimdi bir soru çözelim. 3 ile 5'i toplarsak kaç eder? Hadi birlikte çözelim." },
  {
    "type": "drawing",
    "steps": [
      { "shapes": [
        { "type": "text", "x": 200, "y": 40, "text": "3 + 5 = ?", "fontSize": 22, "fill": "#fbbf24", "anchor": "middle" },
        { "type": "circle", "cx": 80, "cy": 140, "r": 12, "fill": "#60a5fa", "stroke": "#60a5fa", "strokeWidth": 1 },
        { "type": "circle", "cx": 120, "cy": 140, "r": 12, "fill": "#60a5fa", "stroke": "#60a5fa", "strokeWidth": 1 },
        { "type": "circle", "cx": 160, "cy": 140, "r": 12, "fill": "#60a5fa", "stroke": "#60a5fa", "strokeWidth": 1 },
        { "type": "text", "x": 120, "y": 190, "text": "3", "fontSize": 18, "fill": "#60a5fa", "anchor": "middle" }
      ], "speech": "Önce 3 tane yuvarlak çizelim. İşte burada 3 tane." },
      { "shapes": [
        { "type": "circle", "cx": 220, "cy": 140, "r": 12, "fill": "#4ade80", "stroke": "#4ade80", "strokeWidth": 1 },
        { "type": "circle", "cx": 260, "cy": 140, "r": 12, "fill": "#4ade80", "stroke": "#4ade80", "strokeWidth": 1 },
        { "type": "circle", "cx": 300, "cy": 140, "r": 12, "fill": "#4ade80", "stroke": "#4ade80", "strokeWidth": 1 },
        { "type": "circle", "cx": 220, "cy": 180, "r": 12, "fill": "#4ade80", "stroke": "#4ade80", "strokeWidth": 1 },
        { "type": "circle", "cx": 260, "cy": 180, "r": 12, "fill": "#4ade80", "stroke": "#4ade80", "strokeWidth": 1 },
        { "type": "text", "x": 260, "y": 220, "text": "5", "fontSize": 18, "fill": "#4ade80", "anchor": "middle" }
      ], "speech": "Şimdi yanına 5 tane daha ekleyelim. 1, 2, 3, 4, 5. Hepsini sayalım." },
      { "shapes": [
        { "type": "text", "x": 200, "y": 270, "text": "3 + 5 = 8  ✓ Cevap: C", "fontSize": 20, "fill": "#4ade80", "anchor": "middle" }
      ], "speech": "Hepsini sayarsak 1, 2, 3, 4, 5, 6, 7, 8. Evet 8 eder! Doğru cevap C şıkkı." }
    ]
  }`
    : "";

  const validTypes = questionOpts?.includeQuestions
    ? "title, text, formula, list, highlight, drawing, question"
    : "title, text, formula, list, highlight, drawing";

  return `Konu: ${topic}
Seviye: ${level}. sınıf (${schoolType})

Aşağıdaki JSON formatında bir ders tahtası oluştur. ${cfg.items} eleman üret. İlk eleman mutlaka "title" olsun. En az 2 farklı tip kullan.

Örnek format:
[
  { "type": "title", "text": "Ders Başlığı", "speech": "Merhaba çocuklar! Bugün ders başlığı konusunu öğreneceğiz." },
  { "type": "text", "text": "Açıklama metni.", "speech": "Şimdi size açıklama metnini anlatayım." },
  { "type": "formula", "text": "3 + 5 = 8", "speech": "Bakın, 3 ile 5'i toplarsak 8 eder." },
  { "type": "list", "items": ["Madde 1", "Madde 2", "Madde 3"], "speech": "Şimdi maddelerimize bakalım." },
  { "type": "highlight", "text": "Önemli not!", "speech": "Bunu mutlaka hatırlayın çocuklar!" },
  {
    "type": "drawing",
    "steps": [
      { "shapes": [
        { "type": "circle", "cx": 200, "cy": 160, "r": 80, "stroke": "#60a5fa", "strokeWidth": 2 },
        { "type": "text", "x": 200, "y": 60, "text": "Meyveler", "fontSize": 18, "fill": "#60a5fa", "anchor": "middle" }
      ], "speech": "Bir küme çizelim. Bu kümenin adı Meyveler." },
      { "shapes": [
        { "type": "text", "x": 180, "y": 145, "text": "Elma", "fontSize": 14, "fill": "#e8e8d8", "anchor": "middle" },
        { "type": "text", "x": 220, "y": 180, "text": "Armut", "fontSize": 14, "fill": "#e8e8d8", "anchor": "middle" }
      ], "speech": "İçine elma ve armut koyalım. İşte bu bir küme!" }
    ]
  }${questionExample}
]

Kurallar:
- Sadece JSON dizisi döndür, başka hiçbir şey yazma.
- Geçerli tipler: ${validTypes}${questionPrompt}
- drawing: Görsel açıklama gerektiren konularda kullan (kümeler, diyagramlar, şekiller, grafikler).
  İki mod var:
  A) Diyagram modu (coordSystem YOK): Kümeler, Venn şemaları, akış diyagramları, geometrik şekiller (üçgen, dörtgen, çember) için.
     Koordinatlar piksel: x: 0-400, y: 0-300 (y aşağı doğru artar). Şekilleri bu alanda konumla.
  B) Koordinat modu (coordSystem VAR): SADECE gerçek matematik grafikleri için (fonksiyon grafikleri, koordinat geometrisi, sayı doğrusu).
     coordSystem steps'in yanında, drawing nesnesinin üst seviyesinde olmalı (step içinde DEĞİL!):
     { "type": "drawing", "coordSystem": { xMin, xMax, yMin, yMax, showAxes?, showGrid?, gridStep? }, "steps": [...] }
     y yukarı doğru artar.
     Şekil koordinatları xMin-xMax ve yMin-yMax aralığında olmalı (piksel değil, matematik birimi).
     strokeWidth: ~0.04, fontSize: ~0.5, point r: ~0.06 gibi küçük değerler kullan.
     Örnek: birim çember → { type:"circle", cx:0, cy:0, r:1, strokeWidth:0.04, stroke:"#60a5fa" }
  steps: Her adım shapes[] ve speech içerir. Drawing'de speech step seviyesindedir.
  Şekil tipleri: line, circle, arc, rect, text, point, arrow, polygon, ellipse, polyline
  polygon: { type: "polygon", points: [[x1,y1], [x2,y2], [x3,y3]], fill?, stroke?, strokeWidth? }
    points mutlaka dizi içinde [x,y] çiftleri olmalı. Örnek üçgen: points: [[200,50],[100,250],[300,250]]
  polyline: { type: "polyline", points: [[x1,y1], [x2,y2], ...], stroke?, strokeWidth?, smooth?: true }
    smooth: true ile noktalar arası yumuşak eğri çizilir (sinüs, dalga, parabolik eğri gibi). Yeterli nokta kullan (10-20 arası).
  text shape: { type: "text", x, y, text, fontSize?, fill?, anchor?: "start"|"middle"|"end" }
  Açılar derece (0=sağ, saat yönünün tersi).
  Renkler: #f87171 (kırmızı), #60a5fa (mavi), #4ade80 (yeşil), #fbbf24 (sarı), #c084fc (mor)
  ÖNEMLİ: Küme, Venn diyagramı gibi kavramsal çizimlerde coordSystem KULLANMA, diyagram modunu kullan.
  ÖNEMLİ: Geometrik şekiller (üçgen, dörtgen, açılar) diyagram modunu kullan, coordSystem KULLANMA. Üçgen çizmek için polygon kullan: { type: "polygon", points: [[200,50],[100,250],[300,250]], stroke: "#60a5fa", strokeWidth: 2 }
  Yerleşim: Etiket/başlık text'leri şeklin dışında olmalı, üst üste binmemeli. Başlık text'ini şeklin üst kenarından en az 20 piksel yukarıya koy. Elemanları şeklin merkezine yakın yerleştir, kenarlara yapışmasın.
- ${level}. sınıf (${schoolType}) seviyesinde, Türkçe açıkla.
- Sayıları rakamla yaz (5, 10 gibi).
- Formüllerde çok satır varsa her formülü yeni satıra yaz (JSON'da \\n kullan). • karakterini satır ayracı olarak KULLANMA.
- Formüllerde LaTeX sözdizimi KULLANMA (\\le, \\frac, \\sin, \\cos gibi). Düz metin ve Unicode semboller kullan. Örnekler: ≤, ≥, ≠, ×, ÷, √, π, ², ³, ½. Yanlış: "-1 \\le \\sin(x) \\le 1". Doğru: "-1 ≤ sin(x) ≤ 1".
- speech: o item gösterilirken sesli söylenecek metin (${cfg.speechLen}, doğal konuşma dili Türkçe). Her item'da speech olmalı (drawing hariç, drawing'de step'lerde).
- speech'te formül değişkenlerini Türkçe harf adıyla yaz, tek harf bırakma. Örnekler: r → "re", l → "le", h → "he", b → "be", d → "de", n → "ne", x → "iks". π → "pi". Yanlış: "pi r l". Doğru: "pi re le".
- Ders kendi içinde tam olsun. "Şimdi örnek çözeceğiz", "bir sonraki derste göreceğiz" gibi derste olmayan içeriklere atıf yapma. Son item dersi özetleyen veya öğrenileni pekiştiren bir kapanış olsun.`;
}

export { buildLessonSystemPrompt };

export const ANNOTATION_SYSTEM_PROMPT = `Sen ilkokul öğretmenisin. Öğrenci tahtadaki bir öğeye tıklayıp soru sordu.
Kurallar:
- 1-3 cümle ile yanıtla.
- Yanıtında tıklanan elemanın içindeki ifadeyi aynen tekrarla.
- Sayıları rakamla yaz.
- Çocuklara uygun, basit dil kullan.`;

export function buildAnnotationContext(boardItems: BoardItem[], clickedIndex: number): string {
  return boardItems
    .map((item, i) => {
      const marker = i === clickedIndex ? " ← İŞARETLENDİ" : "";
      if (item.type === "list") return `[${i}] (${item.type}) ${item.items.join(", ")}${marker}`;
      if (item.type === "drawing") return `[${i}] (drawing) [çizim: ${item.steps.length} adım]${marker}`;
      if (item.type === "question") return `[${i}] (question) ${item.text}${marker}`;
      return `[${i}] (${item.type}) ${item.text}${marker}`;
    })
    .join("\n");
}

function createClaudeLLMService(): LLMService {
  const client = new Anthropic();

  return {
    async generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions): Promise<LessonBoardItem[]> {
      console.log(`[llm:claude] generating lesson for: ${topic} (grade ${gradeLevel ?? "default"}, length ${length ?? "default"})`);

      const prompt = buildLessonPrompt(topic, gradeLevel, length, questionOpts);
      const systemPrompt = buildLessonSystemPrompt(gradeLevel, length);

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 20000,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
          });
          const block = response.content[0];
          if (block.type !== "text") throw new Error("Unexpected response type");
          return parseBoardItems(block.text) as LessonBoardItem[];
        } catch (err) {
          console.warn(`[llm:claude] generateLesson attempt ${attempt + 1} failed:`, err);
          if (attempt === 1) throw err;
        }
      }

      throw new Error("unreachable");
    },

    async generateSpeechResponse(transcript: string): Promise<string> {
      console.log(`[llm:claude] generating speech response for: "${transcript.slice(0, 60)}..."`);

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: SPEECH_SYSTEM_PROMPT,
        messages: [{ role: "user", content: transcript }],
      });

      const block = response.content[0];
      if (block.type !== "text") {
        throw new Error("Unexpected response type from Claude");
      }
      return block.text;
    },

    streamSpeechResponse(
      transcript: string,
      history: ConversationHistory,
      callbacks: LLMStreamCallbacks,
    ): LLMStreamHandle {
      console.log(`[llm:claude] streaming speech response for: "${transcript.slice(0, 60)}..."`);

      const stream = client.messages.stream({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: SPEECH_SYSTEM_PROMPT,
        messages: history.getMessagesForClaude(),
      });

      let snapshot = "";

      stream.on("text", (delta) => {
        snapshot += delta;
        callbacks.onToken(delta, snapshot);
      });

      stream.on("end", () => {
        callbacks.onDone(snapshot);
      });

      stream.on("error", (err) => {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      });

      return { abort: () => stream.abort() };
    },

    async answerAnnotation(
      boardItems: BoardItem[],
      clickedIndex: number,
      question: string,
      history: ConversationHistory,
    ): Promise<string> {
      console.log(`[llm:claude] annotation click index=${clickedIndex}, question="${question}"`);

      const boardContext = buildAnnotationContext(boardItems, clickedIndex);
      const q = question || "Bu ne demek?";

      const messages = [
        ...history.getMessagesForClaude(),
        { role: "user" as const, content: `Tahta içeriği:\n${boardContext}\n\nSoru: ${q}` },
      ];

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: ANNOTATION_SYSTEM_PROMPT,
        messages,
      });
      const block = response.content[0];
      if (block.type !== "text") throw new Error("Unexpected response type");
      return block.text;
    },
  };
}

export function createLLMService(): LLMService {
  const provider = process.env.LLM_PROVIDER ?? "google";
  const fallbackProvider = process.env.LLM_FALLBACK;

  if (provider === "mock") {
    console.log("[llm] Using Mock provider");
    return createMockLLMService();
  }

  let primary: LLMService;

  if (provider === "anthropic") {
    console.log("[llm] Using Anthropic Claude provider");
    primary = createClaudeLLMService();
  } else {
    console.log("[llm] Using Google Gemini provider");
    primary = createGeminiLLMService();
  }

  if (fallbackProvider === "mock") {
    console.log("[llm] Using Mock fallback provider");
    return createFallbackLLMService(primary, createMockLLMService());
  }

  return primary;
}
