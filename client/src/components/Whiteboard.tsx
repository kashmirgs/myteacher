import { useRef, useEffect, useCallback } from 'react';
import type { BoardItem } from '@myteacher/shared';
import { renderBoard, hitTest, type HitRegion } from '../canvas/renderer';

interface WhiteboardProps {
  items: BoardItem[];
  onAnnotationClick: (index: number) => void;
}

export function Whiteboard({ items, onAnnotationClick }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRegionsRef = useRef<HitRegion[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.clientWidth;
    canvas.height = Math.max(600, canvas.clientHeight);

    hitRegionsRef.current = renderBoard(ctx, items, canvas.width);
  }, [items]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const index = hitTest(hitRegionsRef.current, clickY);
      if (index !== null) {
        onAnnotationClick(index);
      }
    },
    [onAnnotationClick],
  );

  return (
    <canvas
      ref={canvasRef}
      className="whiteboard"
      onClick={handleClick}
    />
  );
}
