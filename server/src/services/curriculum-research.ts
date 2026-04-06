import { GoogleGenAI } from "@google/genai";

export interface CurriculumContext {
  objectives: string[];
  rawText: string;
}

interface CacheEntry {
  data: CurriculumContext;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TIMEOUT_MS = 8000;

function getCacheKey(topic: string, gradeLevel: number): string {
  return `${gradeLevel}:${topic.toLowerCase().trim()}`;
}

export async function researchCurriculum(
  topic: string,
  gradeLevel: number,
  description?: string,
): Promise<CurriculumContext | null> {
  const key = getCacheKey(topic, gradeLevel);
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) {
    console.log(`[curriculum] cache hit for "${topic}" grade ${gradeLevel}`);
    return cached.data;
  }

  if (!process.env.GOOGLE_API_KEY) {
    console.warn("[curriculum] GOOGLE_API_KEY not set, skipping research");
    return null;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

  const descPart = description ? ` (${description})` : "";
  const prompt = `MEB ${gradeLevel}. sınıf müfredatında "${topic}"${descPart} konusuyla ilgili kazanımları ve öğrenme hedeflerini bul. Sadece kazanım kodlarını ve açıklamalarını listele.`;

  try {
    console.log(`[curriculum] researching MEB objectives for "${topic}" grade ${gradeLevel}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 2048,
        abortSignal: controller.signal,
      },
    });

    clearTimeout(timer);

    const rawText = response.text ?? "";
    if (!rawText) {
      console.warn("[curriculum] empty response from research");
      return null;
    }

    const objectives = extractObjectives(rawText);
    console.log(`[curriculum] found ${objectives.length} objectives for "${topic}" grade ${gradeLevel}`);

    const result: CurriculumContext = { objectives, rawText };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    console.warn("[curriculum] research failed, continuing without curriculum context:", err);
    return null;
  }
}

function extractObjectives(text: string): string[] {
  const lines = text.split("\n");
  const objectives: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match lines that look like MEB objectives (e.g., "F.5.4.1.1: ..." or "- M.3.1.2.1. ...")
    const match = trimmed.match(/[A-ZÇĞİÖŞÜ]+\.\d+\.\d+\.\d+\.\d+\.?\s*[:.\-–]\s*.+/);
    if (match) {
      objectives.push(trimmed.replace(/^[-*•]\s*/, ""));
      continue;
    }
    // Also capture bullet points that contain objective-like content with codes
    if (/^[-*•]\s*[A-ZÇĞİÖŞÜ]+\.\d+/.test(trimmed)) {
      objectives.push(trimmed.replace(/^[-*•]\s*/, ""));
    }
  }

  // If no structured objectives found, try to extract meaningful lines
  if (objectives.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-") || trimmed.startsWith("*") || trimmed.startsWith("•")) {
        const content = trimmed.replace(/^[-*•]\s*/, "");
        if (content.length > 15) {
          objectives.push(content);
        }
      }
    }
  }

  return objectives;
}
