import { useState, useEffect } from 'react';
import type { SessionState, TopicSummary } from '@myteacher/shared';

interface ControlsProps {
  isConnected: boolean;
  sessionState: SessionState;
  isOpen: boolean;
  onMicToggle: () => void;
  onGenerateLesson: (topic: string) => void;
  onStartPresetLesson: (topicId: string) => void;
  transcript: string;
  aiResponse: string;
  debugMode: boolean;
  onDebugToggle: (v: boolean) => void;
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
  onStartPresetLesson,
  transcript,
  aiResponse,
  debugMode,
  onDebugToggle,
}: ControlsProps) {
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState('');

  useEffect(() => {
    fetch('/api/topics')
      .then((r) => r.json())
      .then((data) => setTopics(data))
      .catch(() => {});
  }, []);

  const busy = sessionState === 'processing' || sessionState === 'speaking';

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

      {/* Preset topic selection */}
      {topics.length > 0 && (
        <div className="topic-select-group">
          <select
            className="topic-select"
            value={selectedTopicId}
            onChange={(e) => setSelectedTopicId(e.target.value)}
            disabled={!isConnected || busy}
          >
            <option value="">Hazır konu seç...</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} ({t.subject})
              </option>
            ))}
          </select>
          <button
            className="topic-start-btn"
            disabled={!isConnected || busy || !selectedTopicId}
            onClick={() => {
              if (selectedTopicId) {
                onStartPresetLesson(selectedTopicId);
                setSelectedTopicId('');
              }
            }}
          >
            Dersi Başlat
          </button>
        </div>
      )}

      {/* Divider when both options are available */}
      {topics.length > 0 && (
        <div className="or-divider">
          <span>veya</span>
        </div>
      )}

      <form className="lesson-form" onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('topic') as HTMLInputElement;
        if (input.value.trim()) {
          onGenerateLesson(input.value.trim());
          input.value = '';
        }
      }}>
        <input name="topic" placeholder="Konu gir..." disabled={!isConnected || busy} />
        <button type="submit" disabled={!isConnected || busy}>Ders Oluştur</button>
      </form>

      <button
        className={`mic-button ${isOpen ? 'recording' : ''}`}
        onClick={onMicToggle}
        disabled={!isConnected}
      >
        {isOpen ? 'Mikrofonu Kapa' : 'Mikrofonu Aç'}
      </button>

      {debugMode && transcript && (
        <div className="transcript-box">
          <div className="transcript-label">Sen:</div>
          <div className="transcript-text">{transcript}</div>
        </div>
      )}

      {debugMode && aiResponse && (
        <div className="transcript-box ai-response">
          <div className="transcript-label">Öğretmen:</div>
          <div className="transcript-text">{aiResponse}</div>
        </div>
      )}

      <label className="debug-toggle">
        <input
          type="checkbox"
          checked={debugMode}
          onChange={(e) => onDebugToggle(e.target.checked)}
        />
        Debug
      </label>
    </div>
  );
}
