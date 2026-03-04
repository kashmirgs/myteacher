import type { BoardItem } from '@myteacher/shared';

// ── Layout constants ──
const PAD_X = 40;
const PAD_Y = 30;
const LINE_HEIGHT = 28;
const TITLE_SIZE = 32;
const TEXT_SIZE = 18;
const FORMULA_SIZE = 18;
const LIST_SIZE = 17;
const HIGHLIGHT_PAD = 10;
const ITEM_GAP = 20;

export interface HitRegion {
  index: number;
  y: number;
  height: number;
}

/**
 * Render board items to a Canvas 2D context.
 * Returns hit regions for click detection.
 */
export function renderBoard(
  ctx: CanvasRenderingContext2D,
  items: BoardItem[],
  width: number,
): HitRegion[] {
  const hitRegions: HitRegion[] = [];
  let y = PAD_Y;
  const maxTextWidth = width - PAD_X * 2;

  ctx.clearRect(0, 0, width, ctx.canvas.height);
  ctx.textBaseline = 'top';

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const startY = y;

    switch (item.type) {
      case 'title': {
        ctx.font = `bold ${TITLE_SIZE}px sans-serif`;
        ctx.fillStyle = '#1a1a2e';
        const titleWidth = ctx.measureText(item.text).width;
        ctx.fillText(item.text, (width - titleWidth) / 2, y);
        y += TITLE_SIZE + 8;
        break;
      }

      case 'text': {
        ctx.font = `${TEXT_SIZE}px sans-serif`;
        ctx.fillStyle = '#333';
        y = wrapText(ctx, item.text, PAD_X, y, maxTextWidth, LINE_HEIGHT);
        break;
      }

      case 'formula': {
        ctx.font = `${FORMULA_SIZE}px monospace`;
        ctx.fillStyle = '#0a4d68';
        // • delimiter already converted to \n by server
        const lines = item.text.split('\n');
        for (const line of lines) {
          ctx.fillText(line, PAD_X + 10, y);
          y += LINE_HEIGHT;
        }
        break;
      }

      case 'list': {
        ctx.font = `${LIST_SIZE}px sans-serif`;
        ctx.fillStyle = '#444';
        for (const entry of item.items) {
          ctx.fillText(`  \u2022  ${entry}`, PAD_X, y);
          y += LINE_HEIGHT;
        }
        break;
      }

      case 'highlight': {
        ctx.font = `bold ${TEXT_SIZE}px sans-serif`;
        const highlightHeight = LINE_HEIGHT + HIGHLIGHT_PAD * 2;
        ctx.fillStyle = '#fff3cd';
        ctx.fillRect(PAD_X - 5, y, maxTextWidth + 10, highlightHeight);
        ctx.fillStyle = '#856404';
        ctx.fillText(item.text, PAD_X + HIGHLIGHT_PAD, y + HIGHLIGHT_PAD);
        y += highlightHeight;
        break;
      }
    }

    hitRegions.push({ index: i, y: startY, height: y - startY });
    y += ITEM_GAP;
  }

  // Resize canvas height to fit content
  const neededHeight = y + PAD_Y;
  if (ctx.canvas.height < neededHeight) {
    ctx.canvas.height = neededHeight;
  }

  return hitRegions;
}

/** Find which board item was clicked based on y coordinate */
export function hitTest(regions: HitRegion[], clickY: number): number | null {
  for (const r of regions) {
    if (clickY >= r.y && clickY < r.y + r.height) {
      return r.index;
    }
  }
  return null;
}

// ── Helpers ──

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const words = text.split(' ');
  let line = '';
  let curY = y;

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, curY);
      curY += lineHeight;
      line = word;
    } else {
      line = testLine;
    }
  }
  if (line) {
    ctx.fillText(line, x, curY);
    curY += lineHeight;
  }

  return curY;
}
