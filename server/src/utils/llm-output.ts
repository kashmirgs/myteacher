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
                  Array.isArray(p) ? p : [p.x, p.y]
                );
              }
              if (shape.type === 'polyline' && Array.isArray(shape.points)) {
                shape.points = shape.points.map((p: any) =>
                  Array.isArray(p) ? p : [p.x, p.y]
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
