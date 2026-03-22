import { useState, useEffect, useRef } from 'react';
import type { BoardItem } from '@myteacher/shared';
import { DrawingCanvas } from './DrawingCanvas';
import { FractionText } from './FractionText';

interface WhiteboardProps {
  items: BoardItem[];
  revealedCount: number;
  drawingSteps: Record<number, number>;
  onAnnotationClick: (index: number) => void;
  overlayItems?: BoardItem[];
  onOverlayDismiss?: () => void;
}

function QuestionItem({ item }: { item: Extract<BoardItem, { type: 'question' }> }) {
  const [selected, setSelected] = useState<number | null>(null);
  const answered = selected !== null;
  const labels = ['A', 'B', 'C', 'D'];

  return (
    <div className="question-content">
      <div className="question-text"><FractionText text={item.text} /></div>
      <div className="question-options">
        {item.options.map((opt, i) => {
          let cls = 'question-option';
          if (answered) {
            if (i === item.correct) cls += ' correct';
            else if (i === selected) cls += ' wrong';
          }
          return (
            <button
              key={i}
              className={cls}
              disabled={answered}
              onClick={() => setSelected(i)}
            >
              <span className="question-option-label">{labels[i]}</span>
              <FractionText text={opt} />
            </button>
          );
        })}
      </div>
      {answered && (
        <div className={`question-result ${selected === item.correct ? 'correct' : 'wrong'}`}>
          {selected === item.correct ? 'Doğru!' : `Yanlış! Doğru cevap: ${labels[item.correct]}`}
          <div className="question-explanation"><FractionText text={item.explanation} /></div>
        </div>
      )}
    </div>
  );
}

export function Whiteboard({ items, revealedCount, drawingSteps, onAnnotationClick, overlayItems, onOverlayDismiss }: WhiteboardProps) {
  const qaSeparatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (overlayItems && overlayItems.length > 0 && qaSeparatorRef.current) {
      qaSeparatorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [overlayItems]);
  return (
    <div className="board-panel">
      {items.map((item, index) => {
        const visible = index < revealedCount;
        const className = `board-item${visible ? ' board-item--visible' : ''}`;

        if (item.type === 'drawing') {
          return (
            <div key={index} className={className} data-type="drawing">
              <DrawingCanvas item={item} revealedSteps={drawingSteps[index] ?? 0} />
            </div>
          );
        }

        if (item.type === 'question') {
          return (
            <div key={index} className={className} data-type="question">
              <QuestionItem item={item} />
            </div>
          );
        }

        if (item.type === 'list') {
          return (
            <div
              key={index}
              className={className}
              data-type="list"
              onClick={() => onAnnotationClick(index)}
            >
              <ul>
                {item.items.map((entry, i) => (
                  <li key={i}>{entry}</li>
                ))}
              </ul>
            </div>
          );
        }

        const text = item.text;

        return (
          <div
            key={index}
            className={className}
            data-type={item.type}
            onClick={() => onAnnotationClick(index)}
          >
            {text}
          </div>
        );
      })}
      {overlayItems && overlayItems.length > 0 && (
        <>
          <div className="qa-separator" ref={qaSeparatorRef} />
          {overlayItems.map((item, index) => {
            const key = `qa-${index}`;
            if (item.type === 'drawing') {
              if (!item.steps?.length) return null;
              return (
                <div key={key} className="board-item board-item--visible" data-type="drawing">
                  <DrawingCanvas item={item} revealedSteps={item.steps.length} />
                </div>
              );
            }
            if (item.type === 'question') {
              return (
                <div key={key} className="board-item board-item--visible" data-type="question">
                  <QuestionItem item={item} />
                </div>
              );
            }
            if (item.type === 'list') {
              if (!Array.isArray(item.items)) return null;
              return (
                <div key={key} className="board-item board-item--visible" data-type="list">
                  <ul>
                    {item.items.map((entry, i) => (
                      <li key={i}>{entry}</li>
                    ))}
                  </ul>
                </div>
              );
            }
            const text = 'text' in item ? item.text : null;
            if (!text) return null;
            return (
              <div key={key} className="board-item board-item--visible" data-type={item.type}>
                {text}
              </div>
            );
          })}
          <button className="qa-dismiss-floating" onClick={onOverlayDismiss}>
            Anladım ✓
          </button>
        </>
      )}
      <div className="chalk-tray" />
    </div>
  );
}
