import type { BoardItem, BoardItemType } from '@myteacher/shared';
import { KNOWN_BOARD_TYPES } from '@myteacher/shared';

/**
 * Strip common LLM output artifacts before JSON.parse.
 * - Markdown code fences (```json ... ```)
 * - BOM characters
 * - Trailing commas before ] or }
 * - JS-style comments
 * - Text before/after the JSON array/object
 */
export function stripLLMJson(raw: string): string {
  let s = raw.trim();

  // Remove BOM
  s = s.replace(/^\uFEFF/, '');

  // Remove markdown fences
  s = s.replace(/^```(?:json)?\s*\n?/i, '');
  s = s.replace(/\n?```\s*$/i, '');

  // Remove single-line comments (// ...) outside of strings
  s = s.replace(/(?<=^|[^:"])\/\/.*$/gm, '');

  // Remove multi-line comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // Extract just the JSON array/object — LLM may add text before/after
  const firstBracket = s.search(/[\[{]/);
  if (firstBracket > 0) s = s.slice(firstBracket);
  const lastBracket = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (lastBracket > 0) s = s.slice(0, lastBracket + 1);

  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, '$1');

  return s.trim();
}

/**
 * Fix unescaped control characters inside JSON string values.
 * Walks the string respecting escape sequences.
 */
function fixControlCharsInStrings(json: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < json.length) {
    if (json[i] === '"') {
      // Start of a JSON string — copy until closing quote
      out.push('"');
      i++;
      while (i < json.length) {
        const ch = json[i];
        if (ch === '\\') {
          out.push(ch, json[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (ch === '"') {
          out.push('"');
          i++;
          break;
        }
        // Replace unescaped control characters
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          if (ch === '\n') out.push('\\n');
          else if (ch === '\r') out.push('\\r');
          else if (ch === '\t') out.push('\\t');
          else out.push(`\\u${code.toString(16).padStart(4, '0')}`);
        } else {
          out.push(ch);
        }
        i++;
      }
    } else {
      out.push(json[i]);
      i++;
    }
  }
  return out.join('');
}

/**
 * Repair truncated JSON by closing open strings, arrays and objects.
 * Handles LLM output cut short by maxOutputTokens.
 */
function repairTruncatedJson(json: string): string {
  let s = json;
  // If we're inside an unterminated string, close it
  let inString = false;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && inString) { i++; continue; }
    if (s[i] === '"') {
      inString = !inString;
      if (inString) last = i;
    }
  }
  if (inString) {
    // Truncate from the last key-value boundary or comma before the unterminated string
    // to avoid partial values, then close brackets
    s = s.slice(0, last);
    // Remove trailing comma or colon left over
    s = s.replace(/[,:\s]+$/, '');
  }

  // Close open brackets/braces
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && inStr) { i++; continue; }
    if (s[i] === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (s[i] === '[') stack.push(']');
    else if (s[i] === '{') stack.push('}');
    else if (s[i] === ']' || s[i] === '}') stack.pop();
  }
  // Remove trailing comma before adding closers
  s = s.replace(/,\s*$/, '');
  while (stack.length) s += stack.pop();
  return s;
}

/**
 * Attempt JSON.parse with fallback fixups for common LLM quirks:
 * - Single-quoted strings
 * - Unquoted property names
 * - Unescaped control characters in strings
 * - Truncated JSON (unterminated strings, unclosed brackets)
 */
export function parseLLMJson(raw: string): unknown {
  const cleaned = stripLLMJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fix control characters, then retry
    const fixed1 = fixControlCharsInStrings(cleaned);
    try {
      return JSON.parse(fixed1);
    } catch {
      // Fix single-quoted strings and unquoted property names
      const fixed2 = fixed1
        .replace(/'/g, '"')
        .replace(/(\{|,)\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
      try {
        return JSON.parse(fixed2);
      } catch {
        // Last resort: repair truncated JSON
        const repaired = repairTruncatedJson(fixed2);
        return JSON.parse(repaired);
      }
    }
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate board items array per LESSONS.md rules:
 * - Minimum 3 items
 * - Minimum 2 distinct types
 * - No empty text fields
 * - Only known types
 */
export function validateBoard(items: BoardItem[]): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(items)) {
    return { valid: false, errors: ['items is not an array'] };
  }

  if (items.length < 3) {
    errors.push(`minimum 3 items required, got ${items.length}`);
  }

  const types = new Set<BoardItemType>();
  for (const item of items) {
    if (!KNOWN_BOARD_TYPES.includes(item.type as BoardItemType)) {
      errors.push(`unknown type: ${item.type}`);
      continue;
    }
    types.add(item.type);

    // Validate pauseMs if present (used by LessonBoardItem)
    const pauseMs = (item as any).pauseMs;
    if (pauseMs !== undefined) {
      if (typeof pauseMs !== 'number' || pauseMs < 0 || pauseMs > 30000) {
        errors.push(`invalid pauseMs: ${pauseMs} (must be 0-30000)`);
      }
    }

    if (item.type === 'list') {
      if (!Array.isArray(item.items) || item.items.length === 0) {
        errors.push('list item has empty or missing items array');
      }
    } else if (item.type === 'drawing') {
      if (!Array.isArray(item.steps) || item.steps.length === 0) {
        errors.push('drawing item has empty or missing steps array');
      } else {
        // LLM bazen coordSystem'i step içine koyuyor — ilk step'ten hoist et
        if (!item.coordSystem) {
          const firstStepCS = (item.steps[0] as any)?.coordSystem;
          if (firstStepCS) {
            item.coordSystem = firstStepCS;
            for (const step of item.steps) {
              delete (step as any).coordSystem;
            }
          }
        }
        for (let si = 0; si < item.steps.length; si++) {
          const step = item.steps[si];
          if (!Array.isArray(step.shapes)) {
            errors.push(`drawing step ${si} has missing shapes array`);
          } else {
            for (const shape of step.shapes) {
              // LLM sometimes produces points as object {"0":[x,y],"1":[x,y]} instead of array
              if ((shape.type === 'polygon' || shape.type === 'polyline') && shape.points && !Array.isArray(shape.points) && typeof shape.points === 'object') {
                shape.points = Object.values(shape.points);
              }
              if (shape.type === 'polygon' && Array.isArray(shape.points)) {
                shape.points = shape.points.map((p: any) =>
                  Array.isArray(p) ? p as [number, number] : [p.x, p.y] as [number, number]
                );
              }
              if (shape.type === 'polyline' && Array.isArray(shape.points)) {
                shape.points = shape.points.map((p: any) =>
                  Array.isArray(p) ? p as [number, number] : [p.x, p.y] as [number, number]
                );
                if (shape.points.length < 2) {
                  errors.push(`polyline in step ${si} has fewer than 2 points`);
                }
              }
            }
          }
          if (!step.speech || typeof step.speech !== 'string' || step.speech.trim() === '') {
            errors.push(`drawing step ${si} has empty speech`);
          }
        }
      }
    } else if (item.type === 'question') {
      if (!item.text || item.text.trim() === '') {
        errors.push('question item has empty text');
      }
      if (!Array.isArray(item.options) || item.options.length !== 4) {
        errors.push('question item must have exactly 4 options');
      }
      if (typeof item.correct !== 'number' || item.correct < 0 || item.correct > 3) {
        errors.push('question item correct must be 0-3');
      }
      if (!item.explanation || item.explanation.trim() === '') {
        errors.push('question item has empty explanation');
      }
    } else {
      if (!item.text || item.text.trim() === '') {
        errors.push(`${item.type} item has empty text`);
      }
    }
  }

  if (types.size < 2) {
    errors.push(`minimum 2 distinct types required, got ${types.size}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Strip → parse → validate board items from raw LLM output.
 * Returns parsed items or throws with details.
 */
export function parseBoardItems(raw: string): BoardItem[] {
  const cleaned = stripLLMJson(raw);
  const parsed = JSON.parse(cleaned) as BoardItem[];
  const result = validateBoard(parsed);

  if (!result.valid) {
    throw new Error(`Board validation failed: ${result.errors.join('; ')}`);
  }

  return parsed;
}
