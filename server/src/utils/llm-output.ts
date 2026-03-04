import type { BoardItem, BoardItemType } from '@myteacher/shared';
import { KNOWN_BOARD_TYPES } from '@myteacher/shared';

/**
 * Strip common LLM output artifacts before JSON.parse.
 * - Markdown code fences (```json ... ```)
 * - BOM characters
 * - Trailing commas before ] or }
 */
export function stripLLMJson(raw: string): string {
  let s = raw.trim();

  // Remove BOM
  s = s.replace(/^\uFEFF/, '');

  // Remove markdown fences
  s = s.replace(/^```(?:json)?\s*\n?/i, '');
  s = s.replace(/\n?```\s*$/i, '');

  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, '$1');

  return s.trim();
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

    if (item.type === 'list') {
      if (!Array.isArray(item.items) || item.items.length === 0) {
        errors.push('list item has empty or missing items array');
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

  // Convert formula • delimiter → \n
  return parsed.map((item) => {
    if (item.type === 'formula') {
      return { ...item, text: item.text.replace(/•/g, '\n') };
    }
    return item;
  });
}
