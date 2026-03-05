import type { BoardItem } from '@myteacher/shared';

interface WhiteboardProps {
  items: BoardItem[];
  revealedCount: number;
  onAnnotationClick: (index: number) => void;
}

export function Whiteboard({ items, revealedCount, onAnnotationClick }: WhiteboardProps) {
  return (
    <div className="board-panel">
      {items.map((item, index) => {
        const visible = index < revealedCount;
        const className = `board-item${visible ? ' board-item--visible' : ''}`;

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

        const text = item.type === 'formula'
          ? item.text.replace(/ • /g, '\n')
          : item.text;

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
