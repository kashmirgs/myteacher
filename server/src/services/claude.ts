import Anthropic from "@anthropic-ai/sdk";
import type { BoardItem } from "@myteacher/shared";
import { parseBoardItems, parseLLMJson } from "../utils/llm-output.js";
import { createGeminiLLMService } from "./gemini.js";
import { createMockLLMService } from "./mock.js";
import type { ConversationHistory } from "./conversation.js";

/** LLM service — real Anthropic API for speech responses, placeholder for board generation */

export type LessonBoardItem = BoardItem & { speech?: string; pauseMs?: number };

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
  generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions, description?: string): Promise<LessonBoardItem[]>;
  generateSpeechResponse(transcript: string): Promise<string>;
  streamSpeechResponse(
    transcript: string,
    history: ConversationHistory,
    callbacks: LLMStreamCallbacks,
    gradeLevel?: number,
  ): LLMStreamHandle;
  answerAnnotation(
    boardItems: BoardItem[],
    clickedIndex: number,
    question: string,
    history: ConversationHistory,
    gradeLevel?: number,
  ): Promise<string>;
  generateBoardOnly?(speechText: string, history: ConversationHistory): Promise<BoardItem[]>;
  generateTransition?(lastQAResponse: string, nextSpeech: string): Promise<string>;
}

function createFallbackLLMService(primary: LLMService, fallback: LLMService): LLMService {
  return {
    async generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions, description?: string): Promise<LessonBoardItem[]> {
      try {
        return await primary.generateLesson(topic, gradeLevel, length, questionOpts, description);
      } catch (err) {
        console.warn("[llm] primary generateLesson failed, using fallback:", err);
        return fallback.generateLesson(topic, gradeLevel, length, questionOpts, description);
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
      gradeLevel?: number,
    ): LLMStreamHandle {
      let fallbackHandle: LLMStreamHandle | null = null;
      const handle = primary.streamSpeechResponse(transcript, history, {
        onToken: callbacks.onToken,
        onDone: callbacks.onDone,
        onError: (err) => {
          console.warn("[llm] primary streamSpeechResponse failed, using fallback:", err);
          fallbackHandle = fallback.streamSpeechResponse(transcript, history, callbacks, gradeLevel);
        },
      }, gradeLevel);

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
      gradeLevel?: number,
    ): Promise<string> {
      try {
        return await primary.answerAnnotation(boardItems, clickedIndex, question, history, gradeLevel);
      } catch (err) {
        console.warn("[llm] primary answerAnnotation failed, using fallback:", err);
        return fallback.answerAnnotation(boardItems, clickedIndex, question, history, gradeLevel);
      }
    },

    generateBoardOnly: primary.generateBoardOnly ?? fallback.generateBoardOnly,
    generateTransition: primary.generateTransition ?? fallback.generateTransition,
  };
}

export function buildSpeechSystemPrompt(gradeLevel?: number): string {
  const { level, schoolType, tone } = getSchoolInfo(gradeLevel);
  return `Sen "Öğretmenim" adında, ${level}. sınıf (${schoolType}) öğrencilerine Türkçe ders anlatan sıcak ve sabırlı bir öğretmensin.

Kurallar:
- Kısa ve net cevaplar ver (2-3 cümle).
- ${tone}
- Sadece düz metin olarak yanıt ver, markdown veya özel format kullanma.
- Sayıları rakamla yaz (5, 10 gibi), yazıyla değil.
- Her seferinde yeniden tanışma veya merhaba deme. Sohbet devam ediyorsa doğrudan konuya gir.
- Önceki konuşmalardaki bilgileri hatırla ve tutarlı ol. Aynı şeyleri tekrarlama.
- Tahtada bir ders varsa, öğrencinin soruları o dersle ilgili olabilir.
- Ders anlatımı sırasında öğrenci soru sorarsa: kısa ama sıcak bir cevap ver (1-2 cümle). Dersi sen anlatmaya devam etme, sistem otomatik devam edecek. Cevabın 2 veya daha fazla cümle olacaksa, sonuna konuyla ilgili doğal bir anlayış kontrolü ekle (örn: "Bu kısım anlaşıldı mı?", "Toplama işlemi mantıklı geldi mi?", "Burası net mi sence?"). Tek cümlelik kısa cevaplarda ekleme.

Tahta desteği (opsiyonel):
- Cevabın görsel açıklama gerektiriyorsa (formül, liste, diyagram), sesli cevap metninden SONRA ---BOARD--- marker'ı koy ve ardından JSON dizisi ekle.
- Kullanılabilecek tipler: "formula", "text", "highlight", "list", "drawing"
- Basit sorularda (selamlama, evet/hayır) tahta KULLANMA. Sadece gerçekten yardımcı olacaksa kullan.
- En fazla 1-2 board item yeter, kısa tut.
- Örnekler:
  Soru: "3 çarpı 5 kaç eder?"
  Cevap: 3 çarpı 5, 15 eder. Çarpma işlemi tekrarlı toplamadır.
  ---BOARD---
  [{"type":"formula","text":"3 × 5 = 15"}]

  Soru: "Canlıları nasıl sınıflarız?"
  Cevap: Canlıları bitkiler ve hayvanlar olarak iki ana gruba ayırabiliriz.
  ---BOARD---
  [{"type":"list","items":["Bitkiler","Hayvanlar"]}]

  Soru: "Bir dalga çizebilir misin?"
  Cevap: Tabii, sana bir dalga çizeyim. Bakın dalga böyle yukarı aşağı hareket eder.
  ---BOARD---
  [{"type":"drawing","steps":[{"shapes":[{"type":"polyline","points":[[20,150],[60,80],[100,150],[140,220],[180,150],[220,80],[260,150],[300,220],[340,150],[380,80]],"stroke":"#60a5fa","strokeWidth":2,"smooth":true},{"type":"text","x":200,"y":40,"text":"Dalga","fontSize":18,"fill":"#60a5fa","anchor":"middle"}],"speech":"İşte bir dalga. Yukarı çıkıp aşağı iniyor, tıpkı denizdeki dalgalar gibi."}]}]

- Drawing referansı:
  Koordinatlar piksel: x: 0-400, y: 0-300 (y aşağı doğru artar). Şekilleri bu alanda konumla.
  steps: Her adım shapes[] ve speech içerir.
  Şekil tipleri: line, circle, arc, rect, text, point, arrow, polygon, ellipse, polyline, fraction
  polyline: { type: "polyline", points: [[x1,y1], [x2,y2], ...], stroke?, strokeWidth?, smooth?: true }
    smooth: true ile noktalar arası yumuşak eğri çizilir (sinüs, dalga, parabolik eğri gibi). Yeterli nokta kullan (10-20 arası).
    Eğrisel şekillerde ayrık line/arc parçaları KULLANMA, her zaman polyline + smooth: true kullan.
  polygon: { type: "polygon", points: [[x1,y1], [x2,y2], [x3,y3]], fill?, stroke?, strokeWidth? }
  text: { type: "text", x, y, text, fontSize?, fill?, anchor?: "start"|"middle"|"end" }
  Renkler: #f87171 (kırmızı), #60a5fa (mavi), #4ade80 (yeşil), #fbbf24 (sarı), #c084fc (mor)
  Konuyu açıklayacak kadar step ve shape kullan. Yukarıdaki dalga örneğindeki gibi anlamlı ve açıklayıcı bir çizim yap — tek çizgi ile geçiştirme.
- ÖNEMLİ: Eğer cevabında "çiziyorum", "görebilirsin", "tahtaya yazıyorum" gibi bir ifade kullanıyorsan, ---BOARD--- marker'ını ve JSON'u MUTLAKA ekle. Marker olmadan bu tür ifadeler kullanma — ya marker ile birlikte söyle, ya da hiç bahsetme.`;
}

export const SPEECH_SYSTEM_PROMPT = buildSpeechSystemPrompt(1);

export type LessonLength = "short" | "medium" | "long";

function getSchoolInfo(gradeLevel?: number): { level: number; schoolType: string; tone: string } {
  const level = gradeLevel ?? 1;
  if (level <= 4) {
    return { level, schoolType: "ilkokul", tone: "Çocuklara uygun, basit ve eğlenceli bir dil kullan." };
  } else if (level <= 8) {
    return { level, schoolType: "ortaokul", tone: "Öğrencilere uygun, açık ve anlaşılır bir dil kullan." };
  }
  return { level, schoolType: "lise", tone: "Lise öğrencilerine uygun, akademik ama anlaşılır bir dil kullan." };
}

const LESSON_LENGTH_CONFIG: Record<LessonLength, { items: string; speechLen: string }> = {
  short:  { items: "5-7 arası",  speechLen: "1-2 cümle" },
  medium: { items: "8-12 arası", speechLen: "2-3 cümle" },
  long:   { items: "13-18 arası", speechLen: "3-4 cümle" },
};

function buildLessonSystemPrompt(gradeLevel?: number, length?: LessonLength): string {
  const { level, schoolType, tone } = getSchoolInfo(gradeLevel);
  const cfg = LESSON_LENGTH_CONFIG[length ?? "short"];
  return `Sen ${level}. sınıf (${schoolType}) öğretmenisin. Sadece istenen JSON formatında yanıt ver.\nHer eleman için "speech" alanına o elemanın sesli anlatımını yaz (${cfg.speechLen}).\nSpeech alanını, öğrenciyle birebir konuşuyormuş gibi doğal konuşma dilinde yaz. Ders kitabı dili kullanma. "Şimdi şöyle düşünelim...", "Bak burada ilginç bir şey var...", "Mesela şunu hayal et..." gibi doğal ifadeler kullan.\n${tone}`;
}

// Default for WS lesson generation (no grade level info)
export const LESSON_SYSTEM_PROMPT = buildLessonSystemPrompt(1);

export function buildLessonPrompt(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions, description?: string): string {
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
  Soru şıklarında kesir/bölme ifadesi varsa {pay/payda} sözdizimi kullan. Örnek: "1 bölü 4" yerine "{1/4}", "2 tam 3 bölü 4" yerine "2 tam {3/4}".
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
${description ? `Açıklama: ${description}\n` : ''}Seviye: ${level}. sınıf (${schoolType})

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
  Şekil tipleri: line, circle, arc, rect, text, point, arrow, polygon, ellipse, polyline, fraction
  polygon: { type: "polygon", points: [[x1,y1], [x2,y2], [x3,y3]], fill?, stroke?, strokeWidth? }
    points mutlaka dizi içinde [x,y] çiftleri olmalı. Örnek üçgen: points: [[200,50],[100,250],[300,250]]
  polyline: { type: "polyline", points: [[x1,y1], [x2,y2], ...], stroke?, strokeWidth?, smooth?: true }
    smooth: true ile noktalar arası yumuşak eğri çizilir (sinüs, dalga, parabolik eğri gibi). Yeterli nokta kullan (10-20 arası).
  fraction: { type: "fraction", x: 200, y: 150, numerator: "3", denominator: "4", fontSize?: 16, fill?: "#e8e8d8" }
    Kesir ve bölme işlemlerini bu şekille göster. Pay üstte, payda altta, aralarında çizgi olur. Düz metin "3/4" yerine fraction shape kullan.
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
- Drawing içinde kesir/bölme gösterimi gerekiyorsa fraction shape kullan, "3/4" gibi düz metin yazma.
- speech: o item gösterilirken sesli söylenecek metin (${cfg.speechLen}, doğal konuşma dili Türkçe). Her item'da speech olmalı (drawing hariç, drawing'de step'lerde).
- pauseMs (opsiyonel): Bu item'ın speech'i bittikten sonra bir sonraki item'a geçmeden önce beklenecek süre (milisaniye). Varsayılan 400ms. Öğrencinin düşünmesi gereken sorularda veya önemli kavramlardan sonra daha uzun pause kullan (2000-5000ms). Örnek: { "type": "question", ..., "pauseMs": 3000 }
- speech'te formül değişkenlerini Türkçe harf adıyla yaz, tek harf bırakma. Örnekler: r → "re", l → "le", h → "he", b → "be", d → "de", n → "ne", x → "iks". π → "pi". Yanlış: "pi r l". Doğru: "pi re le".
- İlk item (title) speech'i, dersin konusunu tanıtan ve öğrenciyi motive eden sıcak bir giriş olsun. Örnek: "Bugün çok güzel bir konu işleyeceğiz! Hazır mısın?" veya "Hadi bugün birlikte harika bir şey öğrenelim!"
- Bazı item'ların speech'inde öğrenciye yönelik kısa etkileşim soruları sor: "3 artı 5 kaç eder sence?", "Bunu hatırlıyor musun?", "Sence bu neden böyle?". Her 3-4 item'da bir bu tarz bir soru ekle. Öğrenci cevap vermezse ders otomatik devam edecek, sorun olmaz.
- Ders kendi içinde tam olsun. "Şimdi örnek çözeceğiz", "bir sonraki derste göreceğiz" gibi derste olmayan içeriklere atıf yapma. Son item dersi özetleyen veya öğrenileni pekiştiren bir kapanış olsun.`;
}

export { buildLessonSystemPrompt };

export const BOARD_ONLY_SYSTEM_PROMPT = `Aşağıdaki konuşma metnine uygun bir tahta görseli üret. Sadece JSON dizisi döndür, başka hiçbir şey yazma.
Kullanılabilecek tipler: "formula", "text", "highlight", "list", "drawing"
En fazla 1-2 item üret, kısa tut.
ÖNEMLİ: Konuşma metninde çizim, şekil, diyagram, grafik gibi görsel içerik bahsi varsa "drawing" tipi kullan — text veya formula ile geçiştirme.

Drawing referansı:
  İki mod var:
  A) Diyagram modu (coordSystem YOK): Kümeler, Venn şemaları, akış diyagramları, geometrik şekiller, deneysel düzenekler, dalga/sinüs çizimleri için.
     Koordinatlar piksel: x: 0-400, y: 0-300 (y aşağı doğru artar). Şekilleri bu alanda konumla.
  B) Koordinat modu (coordSystem VAR): SADECE gerçek matematik grafikleri için (fonksiyon grafikleri, koordinat geometrisi, sayı doğrusu).
     coordSystem steps'in yanında, drawing nesnesinin üst seviyesinde olmalı (step içinde DEĞİL!):
     { "type": "drawing", "coordSystem": { xMin, xMax, yMin, yMax, showAxes?, showGrid?, gridStep? }, "steps": [...] }
     y yukarı doğru artar.
     Şekil koordinatları xMin-xMax ve yMin-yMax aralığında olmalı (piksel değil, matematik birimi).
     strokeWidth: ~0.04, fontSize: ~0.5, point r: ~0.06 gibi küçük değerler kullan.

  steps: Her adım shapes[] ve speech içerir. Çizimi anlamlı adımlara böl — her step bir kavramsal parça eklesin.
  Şekil tipleri: line, circle, arc, rect, text, point, arrow, polygon, ellipse, polyline, fraction
  polyline: { type: "polyline", points: [[x1,y1], [x2,y2], ...], stroke?, strokeWidth?, smooth?: true }
    smooth: true ile noktalar arası yumuşak eğri çizilir (sinüs, dalga, parabolik eğri gibi).
    ÖNEMLİ: Eğriler için 15-25 nokta kullan, az nokta ile eğri bozuk görünür!
    Eğrisel şekillerde ayrık line/arc parçaları KULLANMA, her zaman polyline + smooth: true kullan.
  polygon: { type: "polygon", points: [[x1,y1], [x2,y2], [x3,y3]], fill?, stroke?, strokeWidth? }
    points mutlaka dizi içinde [x,y] çiftleri olmalı. Örnek üçgen: points: [[200,50],[100,250],[300,250]]
  fraction: { type: "fraction", x: 200, y: 150, numerator: "3", denominator: "4", fontSize?: 16, fill?: "#e8e8d8" }
    Kesir ve bölme işlemlerini bu şekille göster.
  text: { type: "text", x, y, text, fontSize?, fill?, anchor?: "start"|"middle"|"end" }
  arrow: { type: "arrow", x1, y1, x2, y2, stroke?, strokeWidth? }
  Renkler: #f87171 (kırmızı), #60a5fa (mavi), #4ade80 (yeşil), #fbbf24 (sarı), #c084fc (mor)

  Yerleşim kuralları:
  - Etiket/başlık text'leri şeklin dışında olmalı, üst üste binmemeli.
  - Başlık text'ini şeklin üst kenarından en az 20 piksel yukarıya koy.
  - Elemanları şeklin merkezine yakın yerleştir, kenarlara yapışmasın.

  3D geometrik cisimler (koni, silindir, küre, prizma, piramit):
  ÖNEMLİ: Bu cisimleri düz polygon (üçgen/dörtgen) olarak çizme — 3D perspektif kullan.
  - Koni: Altta yatay ellipse (taban), iki kenar çizgisi ellipsin sağ ve sol ucundan tepe noktasına, kesikli yükseklik çizgisi.
  - Eğik koni: Aynı ama tepe noktası taban merkezinden yana kaydırılmış.
  - Silindir: Üstte ve altta yatay ellipse, iki dikey kenar çizgisi.
  - Küre: Daire + ortasından yatay kesikli ellipse (ekvator çizgisi).

  Konuyu açıklayacak kadar step ve shape kullan — tek çizgi ile geçiştirme. Karmaşık konularda 3-5 step, her step'te 3-8 shape kullan.

Örnekler:
  Formül: [{"type":"formula","text":"3 × 5 = 15"}]
  Sinüs dalgası (dikkat: 20 nokta, smooth):
  [{"type":"drawing","steps":[{"shapes":[{"type":"polyline","points":[[10,150],[30,115],[50,85],[70,65],[90,55],[110,65],[130,85],[150,115],[170,150],[190,185],[210,215],[230,235],[250,245],[270,235],[290,215],[310,185],[330,150],[350,115],[370,85],[390,65]],"stroke":"#60a5fa","strokeWidth":2,"smooth":true},{"type":"text","x":200,"y":30,"text":"Sinüs Dalgası","fontSize":18,"fill":"#60a5fa","anchor":"middle"},{"type":"arrow","x1":10,"y1":150,"x2":395,"y2":150,"stroke":"#888","strokeWidth":1},{"type":"text","x":390,"y":140,"text":"x","fontSize":14,"fill":"#888","anchor":"end"}],"speech":"İşte bir sinüs dalgası. Dalga yukarı aşağı salınım yaparak ilerliyor."}]}]
  Young deneyi:
  [{"type":"drawing","steps":[{"shapes":[{"type":"rect","x":30,"y":60,"width":10,"height":180,"fill":"#fbbf24","stroke":"#fbbf24","strokeWidth":1},{"type":"text","x":35,"y":50,"text":"Işık kaynağı","fontSize":12,"fill":"#fbbf24","anchor":"middle"}],"speech":"Önce bir ışık kaynağı koyalım."},{"shapes":[{"type":"rect","x":140,"y":60,"width":6,"height":70,"fill":"#888","stroke":"#888","strokeWidth":1},{"type":"rect","x":140,"y":170,"width":6,"height":70,"fill":"#888","stroke":"#888","strokeWidth":1},{"type":"rect","x":140,"y":135,"width":6,"height":5,"fill":"#888","stroke":"#888","strokeWidth":1},{"type":"text","x":143,"y":50,"text":"Çift yarık","fontSize":12,"fill":"#c084fc","anchor":"middle"},{"type":"line","x1":40,"y1":130,"x2":140,"y2":130,"stroke":"#fbbf24","strokeWidth":1},{"type":"line","x1":40,"y1":170,"x2":140,"y2":170,"stroke":"#fbbf24","strokeWidth":1}],"speech":"Işık, iki dar yarıktan geçiyor. Bu yarıklar ışığı ikiye ayırıyor."},{"shapes":[{"type":"line","x1":146,"y1":130,"x2":320,"y2":80,"stroke":"#60a5fa","strokeWidth":1},{"type":"line","x1":146,"y1":130,"x2":320,"y2":150,"stroke":"#60a5fa","strokeWidth":1},{"type":"line","x1":146,"y1":130,"x2":320,"y2":220,"stroke":"#60a5fa","strokeWidth":1},{"type":"line","x1":146,"y1":170,"x2":320,"y2":80,"stroke":"#4ade80","strokeWidth":1},{"type":"line","x1":146,"y1":170,"x2":320,"y2":150,"stroke":"#4ade80","strokeWidth":1},{"type":"line","x1":146,"y1":170,"x2":320,"y2":220,"stroke":"#4ade80","strokeWidth":1}],"speech":"Her yarıktan geçen ışık dalgaları yayılarak ilerliyor ve birbirleriyle karışıyor."},{"shapes":[{"type":"rect","x":320,"y":60,"width":8,"height":180,"fill":"#1e293b","stroke":"#888","strokeWidth":1},{"type":"rect","x":322,"y":72,"width":4,"height":12,"fill":"#4ade80"},{"type":"rect","x":322,"y":98,"width":4,"height":12,"fill":"#4ade80"},{"type":"rect","x":322,"y":124,"width":4,"height":12,"fill":"#4ade80"},{"type":"rect","x":322,"y":150,"width":4,"height":12,"fill":"#4ade80"},{"type":"rect","x":322,"y":176,"width":4,"height":12,"fill":"#4ade80"},{"type":"rect","x":322,"y":202,"width":4,"height":12,"fill":"#4ade80"},{"type":"text","x":345,"y":80,"text":"Aydınlık","fontSize":11,"fill":"#4ade80","anchor":"start"},{"type":"text","x":345,"y":95,"text":"Karanlık","fontSize":11,"fill":"#f87171","anchor":"start"},{"type":"text","x":328,"y":50,"text":"Ekran","fontSize":12,"fill":"#888","anchor":"middle"}],"speech":"Ekranda aydınlık ve karanlık bantlar oluşuyor. Dalgalar birbirini güçlendirdiğinde aydınlık, zayıflattığında karanlık bant görünüyor. Buna girişim deseni diyoruz."}]}]
  Üçgen: [{"type":"drawing","steps":[{"shapes":[{"type":"polygon","points":[[200,50],[100,250],[300,250]],"stroke":"#60a5fa","strokeWidth":2},{"type":"text","x":200,"y":30,"text":"Üçgen","fontSize":18,"fill":"#60a5fa","anchor":"middle"}],"speech":"İşte bir üçgen."}]}]
  Koni (3D perspektif): [{"type":"drawing","steps":[{"shapes":[{"type":"ellipse","cx":200,"cy":230,"rx":80,"ry":25,"stroke":"#60a5fa","strokeWidth":2},{"type":"line","x1":120,"y1":230,"x2":200,"y2":60,"stroke":"#60a5fa","strokeWidth":2},{"type":"line","x1":280,"y1":230,"x2":200,"y2":60,"stroke":"#60a5fa","strokeWidth":2},{"type":"line","x1":200,"y1":230,"x2":200,"y2":60,"stroke":"#f87171","strokeWidth":1,"dashed":true},{"type":"text","x":200,"y":35,"text":"Koni","fontSize":18,"fill":"#60a5fa","anchor":"middle"},{"type":"text","x":215,"y":145,"text":"h","fontSize":14,"fill":"#f87171","anchor":"start"}],"speech":"İşte bir koni. Tabanı daire şeklinde, tepesi sivri bir noktada birleşiyor. Kırmızı kesikli çizgi yüksekliği gösteriyor."}]}]`;

export function buildAnnotationSystemPrompt(gradeLevel?: number): string {
  const { level, schoolType, tone } = getSchoolInfo(gradeLevel);
  return `Sen ${level}. sınıf (${schoolType}) öğretmenisin. Öğrenci tahtadaki bir öğeye tıklayıp soru sordu.
Kurallar:
- 1-3 cümle ile yanıtla.
- Yanıtında tıklanan elemanın içindeki ifadeyi aynen tekrarla.
- Sayıları rakamla yaz.
- ${tone}

Tahta desteği (opsiyonel):
- Açıklaman görsel gerektiriyorsa, sesli cevap metninden SONRA ---BOARD--- marker'ı koy ve ardından JSON dizisi ekle.
- Kullanılabilecek tipler: "formula", "text", "highlight", "list", "drawing"
- Basit açıklamalarda tahta KULLANMA. Sadece gerçekten yardımcı olacaksa kullan.
- En fazla 1-2 board item yeter, kısa tut.
- Örnek:
  Cevap: Bu formül toplama işlemini gösteriyor. 3 ile 5'i birleştirince 8 elde ederiz.
  ---BOARD---
  [{"type":"formula","text":"3 + 5 = 8"}]`;
}

export const ANNOTATION_SYSTEM_PROMPT = buildAnnotationSystemPrompt(1);

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
    async generateLesson(topic: string, gradeLevel?: number, length?: LessonLength, questionOpts?: QuestionOptions, description?: string): Promise<LessonBoardItem[]> {
      console.log(`[llm:claude] generating lesson for: ${topic} (grade ${gradeLevel ?? "default"}, length ${length ?? "default"})`);

      const prompt = buildLessonPrompt(topic, gradeLevel, length, questionOpts, description);
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
      gradeLevel?: number,
    ): LLMStreamHandle {
      console.log(`[llm:claude] streaming speech response for: "${transcript.slice(0, 60)}..."`);

      const stream = client.messages.stream({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: buildSpeechSystemPrompt(gradeLevel),
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
      gradeLevel?: number,
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
        system: buildAnnotationSystemPrompt(gradeLevel),
        messages,
      });
      const block = response.content[0];
      if (block.type !== "text") throw new Error("Unexpected response type");
      return block.text;
    },

    async generateBoardOnly(speechText: string, history: ConversationHistory): Promise<BoardItem[]> {
      const t0 = performance.now();
      console.log(`[llm:claude] generateBoardOnly for: "${speechText.slice(0, 60)}..."`);

      const messages = [
        ...history.getMessagesForClaude(),
        { role: "user" as const, content: `Konuşma metni: ${speechText}` },
      ];

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: BOARD_ONLY_SYSTEM_PROMPT,
        messages,
      });
      const block = response.content[0];
      if (block.type !== "text") throw new Error("Unexpected response type");
      const items = parseLLMJson(block.text);
      if (!Array.isArray(items)) throw new Error("Expected JSON array");
      const elapsed = (performance.now() - t0).toFixed(0);
      console.log(`[llm:claude] generateBoardOnly done in ${elapsed}ms (${items.length} items)`);
      return items as BoardItem[];
    },

    async generateTransition(lastQAResponse: string, nextSpeech: string): Promise<string> {
      const t0 = performance.now();
      console.log(`[llm:claude] generateTransition`);

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: "Sen bir ilkokul öğretmenisin. Öğrencinin sorusuna cevap verdin, şimdi derse geri dönüyorsun. Tek bir kısa geçiş cümlesi yaz (5-12 kelime). Sadece cümleyi yaz, başka bir şey ekleme.",
        messages: [{ role: "user" as const, content: `Son soru-cevap: "${lastQAResponse.slice(0, 200)}"\nDevam edilecek konu: "${nextSpeech.slice(0, 200)}"` }],
      });
      const block = response.content[0];
      if (block.type !== "text") throw new Error("Unexpected response type");
      const elapsed = (performance.now() - t0).toFixed(0);
      console.log(`[llm:claude] generateTransition done in ${elapsed}ms: "${block.text}"`);
      return block.text.trim();
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
