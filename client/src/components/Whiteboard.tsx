import { useState } from 'react';
import type { BoardItem } from '@myteacher/shared';
import { DrawingCanvas } from './DrawingCanvas';

interface WhiteboardProps {
  items: BoardItem[];
  revealedCount: number;
  drawingSteps: Record<number, number>;
  onAnnotationClick: (index: number) => void;
}

function QuestionItem({ item }: { item: Extract<BoardItem, { type: 'question' }> }) {
  const [selected, setSelected] = useState<number | null>(null);
  const answered = selected !== null;
  const labels = ['A', 'B', 'C', 'D'];

  return (
    <div className="question-content">
      <div className="question-text">{item.text}</div>
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
              {opt}
            </button>
          );
        })}
      </div>
      {answered && (
        <div className={`question-result ${selected === item.correct ? 'correct' : 'wrong'}`}>
          {selected === item.correct ? 'Doğru!' : `Yanlış! Doğru cevap: ${labels[item.correct]}`}
          <div className="question-explanation">{item.explanation}</div>
        </div>
      )}
    </div>
  );
}

export function Whiteboard({ items, revealedCount, drawingSteps, onAnnotationClick }: WhiteboardProps) {
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
      <div className="chalk-tray" />
    </div>
  );
}
