import { useState, useEffect, useCallback } from "react";
import type { TopicSummary, BoardItem } from "@myteacher/shared";

interface TopicDetail extends TopicSummary {
  boardItems: string;
  createdAt: string;
  updatedAt: string;
}

type LessonBoardItem = BoardItem & { speech?: string };

const GRADE_LEVELS = [
  { value: 1, label: "1. Sınıf (İlkokul)" },
  { value: 2, label: "2. Sınıf (İlkokul)" },
  { value: 3, label: "3. Sınıf (İlkokul)" },
  { value: 4, label: "4. Sınıf (İlkokul)" },
  { value: 5, label: "5. Sınıf (Ortaokul)" },
  { value: 6, label: "6. Sınıf (Ortaokul)" },
  { value: 7, label: "7. Sınıf (Ortaokul)" },
  { value: 8, label: "8. Sınıf (Ortaokul)" },
  { value: 9, label: "9. Sınıf (Lise)" },
  { value: 10, label: "10. Sınıf (Lise)" },
  { value: 11, label: "11. Sınıf (Lise)" },
  { value: 12, label: "12. Sınıf (Lise)" },
];

const SUBJECTS = [
  "Matematik",
  "Türkçe",
  "Hayat Bilgisi",
  "Fen Bilimleri",
  "Sosyal Bilgiler",
  "Müzik",
  "Görsel Sanatlar",
  "İngilizce",
  "Fizik",
  "Kimya",
  "Biyoloji",
  "Tarih",
  "Coğrafya",
  "Edebiyat",
  "Felsefe",
];

const LESSON_LENGTHS = [
  { value: "short", label: "Kısa (~1 dk)" },
  { value: "medium", label: "Orta (~3 dk)" },
  { value: "long", label: "Uzun (~5 dk)" },
];

export function Admin() {
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [gradeLevel, setGradeLevel] = useState(1);
  const [subject, setSubject] = useState(SUBJECTS[0]);
  const [lessonLength, setLessonLength] = useState("medium");
  const [includeQuestions, setIncludeQuestions] = useState(false);
  const [examStyle, setExamStyle] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<LessonBoardItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchTopics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/topics?all=true");
      setTopics(await res.json());
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchTopics();
  }, [fetchTopics]);

  const handleGenerate = async () => {
    if (!title.trim()) return;
    setGenerating(true);
    setPreview(null);
    setError("");
    try {
      const res = await fetch("/api/topics/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: title, gradeLevel, length: lessonLength, includeQuestions, examStyle: includeQuestions && examStyle }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "LLM üretimi başarısız");
        return;
      }
      if (data.boardItems) {
        setPreview(data.boardItems);
      }
    } catch (err) {
      console.error("Generate failed:", err);
      setError("Sunucuya bağlanılamadı");
    }
    setGenerating(false);
  };

  const handleSave = async () => {
    if (!preview || !title.trim()) return;
    setSaving(true);
    try {
      const url = editingId ? `/api/topics/${editingId}` : "/api/topics";
      const method = editingId ? "PUT" : "POST";
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || null,
          gradeLevel,
          subject,
          boardItems: preview,
        }),
      });
      resetForm();
      void fetchTopics();
    } catch (err) {
      console.error("Save failed:", err);
    }
    setSaving(false);
  };

  const handleEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/topics/${id}`);
      const topic: TopicDetail = await res.json();
      setEditingId(id);
      setTitle(topic.title);
      setDescription(topic.description ?? "");
      setGradeLevel(topic.gradeLevel);
      setSubject(topic.subject);
      setPreview(JSON.parse(topic.boardItems));
    } catch (err) {
      console.error("Edit load failed:", err);
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    await fetch(`/api/topics/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    void fetchTopics();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Bu konuyu silmek istediğinize emin misiniz?")) return;
    await fetch(`/api/topics/${id}`, { method: "DELETE" });
    void fetchTopics();
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setGradeLevel(1);
    setSubject(SUBJECTS[0]);
    setLessonLength("medium");
    setIncludeQuestions(false);
    setExamStyle(false);
    setPreview(null);
    setEditingId(null);
    setError("");
  };

  return (
    <div className="admin">
      <header className="admin-header">
        <h1>MyTeacher Admin</h1>
        <a href="/" className="admin-back">
          Uygulamaya Dön
        </a>
      </header>

      <div className="admin-layout">
        {/* Left: Form */}
        <section className="admin-form-section">
          <h2>{editingId ? "Konuyu Düzenle" : "Yeni Konu Oluştur"}</h2>

          <div className="admin-field">
            <label>Başlık / Konu</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Örn: Toplama İşlemi"
            />
          </div>

          <div className="admin-field">
            <label>Açıklama (opsiyonel)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Kısa açıklama..."
            />
          </div>

          <div className="admin-row">
            <div className="admin-field">
              <label>Sınıf</label>
              <select
                value={gradeLevel}
                onChange={(e) => setGradeLevel(Number(e.target.value))}
              >
                {GRADE_LEVELS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-field">
              <label>Ders</label>
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="admin-field">
            <label>Ders Uzunluğu</label>
            <div className="length-options">
              {LESSON_LENGTHS.map((l) => (
                <label
                  key={l.value}
                  className={`length-option ${lessonLength === l.value ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="lessonLength"
                    value={l.value}
                    checked={lessonLength === l.value}
                    onChange={(e) => setLessonLength(e.target.value)}
                  />
                  {l.label}
                </label>
              ))}
            </div>
          </div>

          <div className="admin-field">
            <label className="question-checkbox">
              <input
                type="checkbox"
                checked={includeQuestions}
                onChange={(e) => {
                  setIncludeQuestions(e.target.checked);
                  if (!e.target.checked) setExamStyle(false);
                }}
              />
              Soru Sor
            </label>
            {includeQuestions && (
              <label className="question-checkbox exam-style">
                <input
                  type="checkbox"
                  checked={examStyle}
                  onChange={(e) => setExamStyle(e.target.checked)}
                />
                {gradeLevel >= 5 && gradeLevel <= 8
                  ? "LGS formatı"
                  : gradeLevel >= 9
                    ? "YKS/AYT formatı"
                    : "Basit alıştırma"}
              </label>
            )}
          </div>

          <div className="admin-actions">
            <button
              className="btn btn-generate"
              onClick={handleGenerate}
              disabled={generating || !title.trim()}
            >
              {generating ? "Üretiliyor..." : "LLM ile Ders Üret"}
            </button>
            {preview && (
              <button
                className="btn btn-save"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Kaydediliyor..." : editingId ? "Güncelle" : "Kaydet"}
              </button>
            )}
            {editingId && (
              <button className="btn btn-cancel" onClick={resetForm}>
                İptal
              </button>
            )}
          </div>

          {error && (
            <div className="admin-error">{error}</div>
          )}

          {/* Preview */}
          {preview && (
            <div className="admin-preview">
              <h3>Önizleme</h3>
              <div className="preview-items">
                {preview.map((item, i) => (
                  <div key={i} className="preview-item">
                    <span className="preview-type">{item.type}</span>
                    <span className="preview-content">
                      {"text" in item ? item.text : ""}
                      {"items" in item ? (item as any).items.join(", ") : ""}
                      {"options" in item ? ` [${(item as any).options.join(" | ")}]` : ""}
                    </span>
                    {item.speech && (
                      <div className="preview-speech">{item.speech}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Right: Topic list */}
        <section className="admin-list-section">
          <h2>Konular ({topics.length})</h2>
          {loading ? (
            <p>Yükleniyor...</p>
          ) : topics.length === 0 ? (
            <p className="admin-empty">Henüz konu eklenmemiş.</p>
          ) : (
            <div className="admin-topic-list">
              {topics.map((t) => (
                <div
                  key={t.id}
                  className={`admin-topic-card ${!t.isActive ? "inactive" : ""}`}
                >
                  <div className="topic-card-header">
                    <strong>{t.title}</strong>
                    <span className="topic-meta">
                      {GRADE_LEVELS.find((g) => g.value === t.gradeLevel)?.label ?? `${t.gradeLevel}. Sınıf`} · {t.subject}
                    </span>
                  </div>
                  {t.description && (
                    <p className="topic-desc">{t.description}</p>
                  )}
                  <div className="topic-card-actions">
                    <button onClick={() => handleEdit(t.id)}>Düzenle</button>
                    <button onClick={() => handleToggleActive(t.id, t.isActive)}>
                      {t.isActive ? "Pasif Yap" : "Aktif Yap"}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => handleDelete(t.id)}
                    >
                      Sil
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
