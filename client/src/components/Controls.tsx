import type { SessionState } from '@myteacher/shared';

interface ControlsProps {
  isConnected: boolean;
  sessionState: SessionState;
  isOpen: boolean;
  onMicToggle: () => void;
  onGenerateLesson: (topic: string) => void;
  transcript: string;
  aiResponse: string;
}

const STATE_COLORS: Record<SessionState, string> = {
  idle: '#6c757d',
  listening: '#28a745',
  processing: '#ffc107',
  speaking: '#007bff',
};

const STATE_LABELS: Record<SessionState, string> = {
  idle: 'Hazır',
  listening: 'Dinliyor',
  processing: 'Düşünüyor',
  speaking: 'Konuşuyor',
};

export function Controls({
  isConnected,
  sessionState,
  isOpen,
  onMicToggle,
  onGenerateLesson,
  transcript,
  aiResponse,
}: ControlsProps) {
  return (
    <div className="controls">
      <div className="status-row">
        <span
          className="connection-dot"
          style={{ backgroundColor: isConnected ? '#28a745' : '#dc3545' }}
        />
        <span className="connection-label">
          {isConnected ? 'Bağlı' : 'Bağlantı yok'}
        </span>
      </div>

      <div className="status-row">
        <span
          className="state-dot"
          style={{ backgroundColor: STATE_COLORS[sessionState] }}
        />
        <span className="state-label">{STATE_LABELS[sessionState]}</span>
      </div>

      <form className="lesson-form" onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('topic') as HTMLInputElement;
        if (input.value.trim()) {
          onGenerateLesson(input.value.trim());
          input.value = '';
        }
      }}>
        <input name="topic" placeholder="Konu gir..." disabled={!isConnected || sessionState === 'processing' || sessionState === 'speaking'} />
        <button type="submit" disabled={!isConnected || sessionState === 'processing' || sessionState === 'speaking'}>Ders Oluştur</button>
      </form>

      <button
        className={`mic-button ${isOpen ? 'recording' : ''}`}
        onClick={onMicToggle}
        disabled={!isConnected}
      >
        {isOpen ? 'Durdur' : 'Mikrofon'}
      </button>

      {transcript && (
        <div className="transcript-box">
          <div className="transcript-label">Sen:</div>
          <div className="transcript-text">{transcript}</div>
        </div>
      )}

      {aiResponse && (
        <div className="transcript-box ai-response">
          <div className="transcript-label">Öğretmen:</div>
          <div className="transcript-text">{aiResponse}</div>
        </div>
      )}
    </div>
  );
}
