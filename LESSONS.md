# Lessons Learned — Test 3, Test 4 & Test 5

## Test 3: Barge-in / Interrupt Sistemi

### Problem
Öğretmen TTS ile konuşurken öğrencinin araya girip (barge-in) soru sorabilmesi. Tam pipeline: VAD ile konuşma algılama → interrupt sinyali → Deepgram STT ile transkript → LLM yanıt → TTS ile sesli cevap → ders kaldığı yerden devam. 4 commit boyunca iteratif olarak geliştirildi.

### Ne İşe Yaramadı

**1. Browser AEC kapalıyken VAD kullanmak**
TTS hoparlörden çıkan ses mikrofona sızıyor (echo/bleed). AEC kapalıyken VAD threshold'u çok yüksek tutmak gerekiyor (`0.025`) ki TTS'i konuşma sanmasın — ama bu sefer gerçek konuşmayı da kaçırıyor. İlk commit'te `echoCancellation: false` ile başlandı, threshold ayarlamak bir kedi-fare oyununa döndü.

**2. MediaRecorder + WebM ile ses yakalamak**
`MediaRecorder` API'si tarayıcılar arası güvenilmez: WebM header'ları her chunk'ta tekrarlanmıyor, temporal kontrol yok (tam olarak ne zaman başladığını bilemiyorsun), ve Deepgram'a gönderirken encoding/sample_rate belirsiz. Pre-speech audio'yu yakalamak için "early start" hack'i gerekti ama bu da kendi sorunlarını getirdi.

**3. Interrupt ack'ı task cleanup'tan sonra göndermek**
İlk implementasyonda `handle_interrupt()` önce `lesson_task` ve `responding_task`'ı cancel edip await ediyordu, sonra `interrupt_ack` gönderiyordu. Async task cancellation bazen 100-200ms sürüyor — bu süre boyunca kullanıcı "sistem beni duydu mu?" belirsizliğinde kalıyor. Algılanan gecikme gerçek gecikmeden çok daha kötü hissettiriyor.

**4. TTS hızını string olarak geçmek**
Cartesia Sonic-3 modeli `generation_config.speed` parametresinde float değer bekliyor (`0.7`, `0.9`, `1.1`). String-based `speed` parametresi ("slow", "normal", "fast") ile geçmek sessizce ignore ediliyor veya hata veriyor. API dökümantasyonu yanıltıcı olabiliyor — gerçek davranışı test et.

### Final Çözümün Prensipleri

**Browser AEC'ye güven (platform özelliklerini kapat değil, aç):**
`getUserMedia({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })` ile tarayıcının OS-level echo cancellation'ını etkinleştirmek, TTS bleed sorununu kökünden çözüyor. AEC açıldığında VAD threshold'u `0.025`'ten `0.012`'ye (sonra `0.015`'e fine-tune) düşürülebildi — normal konuşma artık güvenilir şekilde algılanıyor. Genel prensip: platform'un sunduğu sinyal işleme özelliklerini kapatıp kendini yazmaya çalışma, aç ve üzerine inşa et.

**AudioWorklet + PCM ring buffer (MediaRecorder yerine):**
`AudioWorklet` içinde sürekli dönen bir circular Float32Array ring buffer. Her zaman yazıyor, böylece pre-speech audio asla kaybolmuyor. Deepgram bağlandığında tüm ring buffer Int16 PCM olarak flush ediliyor, sonra canlı streaming başlıyor. MediaRecorder'ın tüm sorunlarını (header, encoding, temporal kontrol) ortadan kaldırıyor. `float32ToInt16()` dönüşümü ile Deepgram'ın `linear16` encoding'ine direkt uyum.

**Ack-before-cleanup pattern:**
`handle_interrupt()` içinde önce `interrupt_ack` mesajını gönder ve state'i `LISTENING`'e geçir, sonra task cancellation'ı yap. Kullanıcı anında geri bildirim alıyor, async cleanup arka planda tamamlanıyor. Genel prensip: kullanıcıya "seni duydum" sinyalini, işlem tamamlanmadan önce gönder.

**Sliding window VAD (timer-based debounce yerine):**
Son N frame'in (window) kaçının threshold'u aştığına bakarak karar ver. 8 frame'lik pencerede 3 frame yeterliyse konuşma var. Timer-based debounce'a göre avantajları: (1) kısa patlamaları (öksürük, kapı) filtreliyor, (2) sürekli konuşmayı hemen algılıyor, (3) parametreleri bağımsız tune edebiliyorsun (window size vs trigger count vs threshold).

**State machine ile geçiş kontrolü:**
`IDLE → TEACHING → LISTENING → RESPONDING → TEACHING` state machine'i, hem backend (`TeachingSession`) hem frontend'de senkron tutuluyor. Her state'te hangi aksiyonların geçerli olduğu açık: TEACHING'de interrupt kabul edilir, LISTENING'de STT aktif, RESPONDING'de yeni interrupt beklenebilir. Race condition'ları state guard'ları ile önleniyor (örn. `dgConnecting` flag'i concurrent STT bağlantılarını engelliyor).

### Kritik Parametreler

**VAD Parametreleri — Evrim Tablosu:**

| Parametre | v1 (AEC kapalı) | v2 (AEC açık) | v3 (fine-tune) | Neden |
|-----------|-----------------|---------------|-----------------|-------|
| `VAD_THRESHOLD` (idle) | 0.008 | 0.008 | 0.008 | Sessiz ortamda konuşma algılama, değişmedi |
| `VAD_INTERRUPT_THRESHOLD` (TTS aktif) | 0.025 | 0.012 | 0.015 | AEC ile düşürüldü, sonra residual rejection için hafif artırıldı |
| `VAD_WINDOW_SIZE` | 8 frames | 8 frames | 8 frames | ~400ms pencere, kısa patlamaları filtreliyor |
| `VAD_TRIGGER_COUNT_NORMAL` | 3/8 | 3/8 | 3/8 | Normal modda hassasiyet |
| `VAD_TRIGGER_COUNT_TTS` | 3/8 | 4/8 | 4/8 | TTS modda ekstra guard (AEC residual) |

**Diğer Kritik Parametreler:**

| Parametre | Değer | Neden |
|-----------|-------|-------|
| `RING_BUFFER_MS` | 1500ms (3000'den düşürüldü) | AEC ile residual audio azaldı, daha kısa buffer yeterli |
| `SILENCE_TIMEOUT_MS` | 1500ms | Konuşma bitişini algılama; çok kısa → erken kesme, çok uzun → gecikme |
| TTS speed (slow) | 0.7 (float) | Ders anlatımı için yavaş tempo; string değil float! |
| TTS speed (normal) | 0.9 (float) | Soru yanıtı için normal tempo |
| TTS speed (fast) | 1.1 (float) | Kısa onay/geçiş için hızlı tempo |
| Interrupt FAST/PASS | < 500ms | Kullanıcının "anında" hissettiği eşik |
| Interrupt OK/PARTIAL | ≤ 1000ms | Kabul edilebilir gecikme |
| Interrupt SLOW/FAIL | > 1000ms | Kullanıcı deneyimini bozan gecikme |
| TTS retry | max 1 | Cartesia bağlantı hatalarında tek retry yeterli |
| TTS timeout | 30s | Takılma önleme; 30s'yi aşarsa abort |

### Edge Case'ler ve Workaround'lar

- **Erken ses yakalama (pre-speech clipping):** VAD onaylamadan önce, ilk above-threshold frame'de ring buffer zaten yazıyor. Deepgram bağlandığında tüm ring buffer flush ediliyor, böylece konuşmanın başı kesilmiyor. MediaRecorder döneminde "early start" hack'i gerekliydi, ring buffer bunu doğal olarak çözüyor.
- **Çift interrupt:** Kullanıcı LISTENING state'inde tekrar konuşursa, zaten doğru state'te — yeni interrupt gerekmez. RESPONDING state'inde interrupt gelirse, mevcut responding_task cancel edilip tekrar LISTENING'e geçilir. State machine her durumu handle ediyor.
- **Silence retry (konuşma enerjisi var ama transkript yok):** `heardSpeechEnergy` flag'i ve `speechNoTranscriptStreak` sayacı ile: VAD enerji algılıyor ama Deepgram transkript döndürmüyorsa, bir kez retry yapılıyor. İkinci başarısızlıkta `silence_timeout` gönderiliyor. Ağ gecikmesi veya çok kısa utterance'lar için koruma.
- **Rollback on interrupt:** Interrupt geldiğinde öğretmenin yarıda kalan board item'ı frontend'de geri alınıyor (`rollback_to_index`). Ders devam ettiğinde o item'dan tekrar başlıyor, böylece öğrenci yarım kalan açıklamayı tam olarak duyuyor.
- **Cartesia lazy startup:** Server boot sırasında Cartesia WebSocket bağlantısı try/except ile sarılıyor. API kullanılamaz olsa bile server ayağa kalkıyor. İlk TTS isteğinde bağlantı kurulur. Dış servise bağımlılık server'ın boot'unu engellemememeli.
- **Transcript fallback (final vs interim):** `pickBestTranscript(finalText, interimText)` — Deepgram'ın final transcript'i tercih edilir, yoksa en son interim kullanılır. Kısa utterance'larda Deepgram bazen final göndermeden kapanabiliyor.

---

## Test 4: LLM Structured Output + Canvas Rendering

### Problem
LLM'den yapılandırılmış (structured) JSON çıktı alıp, bunu görsel bir canvas'a render etmek. Hem JSON'un geçerli olması, hem yeterli sayıda/çeşitlilikte öğe üretilmesi, hem de render'ın hatasız çalışması gerekiyor.

### Ne İşe Yaramadı

**1. LLM'e tek şans vermek**
LLM bazen geçersiz JSON üretir (markdown fence'ler ekler, trailing comma bırakır, açıklama metni ekler). Tek çağrıda %100 başarı varsaymak fragile.

**2. JSON çıktıyı olduğu gibi parse etmeye çalışmak**
LLM sıklıkla JSON'u ` ```json ... ``` ` bloğu içine sarar. Ham çıktıyı doğrudan `JSON.parse()` yapmak başarısız olur.

### Final Çözümün Prensipleri

**Retry with identical prompt:** Aynı prompt'u bir kez daha göndermek, LLM'in farklı bir "yoldan" geçerli JSON üretmesini sağlıyor. İlk denemede %95, retry ile %99+ başarı oranı. Prompt'u değiştirme, aynısını tekrarla.

**Strip before parse:** Parse etmeden önce bilinen LLM kirlerini temizle:
- Markdown code fence'leri (```` ```json ... ``` ````)
- BOM karakterleri
- Trailing comma

Bu kural LLM-agnostik: hangi model olursa olsun, aynı temizleme katmanı gerekir.

**Schema-as-example, not description:** Prompt'ta "şu alanları üret" demek yerine, beklenen JSON'un tam bir örneğini vermek çok daha güvenilir. LLM'ler yapıyı taklit etmede, soyut talimatları izlemekten daha başarılı.

**Validate after parse, don't trust:** JSON geçerli olsa bile, içerik doğrulaması şart:
- Minimum öğe sayısı (>=3)
- Minimum tip çeşitliliği (>=2 farklı type)
- Boş text kontrolü
- Bilinmeyen type kontrolü

### Kritik Parametreler

| Parametre | Değer | Neden |
|-----------|-------|-------|
| `max_tokens` | 2048 | 5-10 item için yeterli; daha düşük değerde items kesilir |
| Min items | 3 | Anlamlı bir ders için alt sınır |
| Min type diversity | 2 | Sadece text üretirse render monoton olur |
| Retry count | 1 | İkinci deneme yeterli; 3+ retry diminishing returns |
| Typewriter speed | 50-70ms/char | Sesle senkron yoksa, okunabilir hız |
| Inter-item pause | 600ms | Öğeler arası görsel nefes alma |

### Edge Case'ler ve Workaround'lar

- **LLM bazen 15+ item üretir:** Prompt'ta "5-10 arası" desen bile. Üst limit koymak yerine render'ın uzun listeyi handle etmesi daha sağlam.
- **Formula tipi `•` ayracı kullanıyor:** LLM çok satırlı formülleri `•` ile ayırıyor. Render katmanı bunu `\n` ile replace etmeli (`white-space: pre-line` ile).
- **Title her zaman ilk olmalı:** Prompt'a "ilk item title olsun" yazılmalı, yoksa LLM bazen text ile başlar.

---

## Test 5: Öğrenci Annotasyon + Bağlam Doğruluğu

### Problem
Öğrenci tahtadaki bir öğeye tıklayıp soru soruyor. LLM'in doğru öğeye odaklanması ve bağlamsal olarak tutarlı yanıt vermesi gerekiyor.

### Ne İşe Yaramadı

**1. LLM'e sadece "odaklan" demek**
"İşaretlenen elemana odaklan" talimatı yeterli değil. LLM genel bir açıklama yapıyor ama tıklanan elemanın spesifik içeriğini (formül, sayı, terim) yanıtında kullanmıyor. Bu da bağlam doğrulama heuristiğinde false-negative'e yol açıyor.

**2. Sayıları rakam olarak bekleyip Türkçe kelime almak**
LLM "5" yerine "beş", "12" yerine "on iki" yazıyor. Token-matching heuristiği rakam arıyor ama bulamıyor. Bu, her doğal dilde olan bir sorun — İngilizce'de de "five" vs "5" aynı problem.

**3. Sadece uzun kelimeleri token olarak almak (>=4 karakter)**
Formüller ve adımlar kısa kelimeler içerir. 4 karakter eşiği çok fazla token'ı dışarıda bırakıyor. Özellikle matematik bağlamında kısa terimler önemli.

### Final Çözümün Prensipleri

**Echo constraint — LLM'e kaynak materyali tekrar ettir:**
Prompt'a "yanıtında tıklanan elemanın içindeki ifadeyi aynen tekrarla" eklemek. Bu, LLM'in soyut açıklama yerine somut referans vermesini zorluyor. Dile bağımsız prensip: LLM'den bağlamsal cevap istiyorsan, kaynak materyali yanıtta echo etmesini iste.

**Canonical format constraint — Sayıları rakamla yazdır:**
"Sayıları rakamla yaz (beş değil 5)" talimatı. Bu, downstream token matching'i güvenilir kılıyor. Genel prensip: LLM çıktısının programatik olarak doğrulanacağını biliyorsan, çıktı formatını açıkça belirt.

**Multi-layer validation — Token matching + Fallback:**
Tek bir matching stratejisi yeterli değil:
1. Önce doğrudan substring match (ana strateji)
2. Sonra sayı-kelime dönüşümü fallback (Türkçe'de "üç" = 3 gibi)
3. Token'sız öğeler için auto-pass

**Context windowing — Tüm tahtayı göster, birini işaretle:**
Sadece tıklanan öğeyi göndermek yerine, tüm tahtayı context olarak verip tıklanan öğeyi `← İŞARETLENDİ` ile markalamak. LLM hem bağlamı görüyor hem odak noktasını biliyor.

### Kritik Parametreler

| Parametre | Değer | Neden |
|-----------|-------|-------|
| `max_tokens` | 512 | Kısa yanıt (1-3 cümle) için yeterli |
| Token min length | 3 karakter | 4'ten düşürüldü; kısa Türkçe kelimeler için |
| Pass threshold | 8/10 senaryo | LLM non-deterministic; %100 beklemek gerçekçi değil |
| Partial threshold | 6/10 | Altı ciddi sorun demek |

### Edge Case'ler ve Workaround'lar

- **Boş soru:** Öğrenci soru sormadan tıklayabilir. Default soru ata: `"Bu ne demek?"`. Backend'de `or "Bu ne demek?"` fallback'i.
- **Çift tıklama (double-click):** Kullanıcı hızla iki farklı öğeye tıklarsa, son tıklanan geçerli. İlk seçimi iptal et, ikincisini gönder.
- **Son item (index -1):** Frontend'de `items.length - 1` olarak çevir. Backend'e negatif index gönderme, çünkü `0 <= clicked_index < len(items)` doğrulaması başarısız olur.
- **Ortadaki item (index "mid"):** `Math.floor(items.length / 2)` ile çevir. Hesaplanmış indeksler frontend sorumluluğu, backend sadece geçerli tam sayı kabul eder.
- **LLM formüllerde parafraz yapıyor:** "x + 5 = 12" yerine "x artı beş eşittir on iki" yazıyor. Echo constraint bu sorunu büyük ölçüde çözer ama %100 garanti yok; threshold-based pass/fail (8/10) bu belirsizliği absorbe eder.

---

## Ortak Prensipler (Test 3 + Test 4 + Test 5)

### 1. LLM Çıktısına Güvenme, Doğrula
LLM non-deterministic. Aynı prompt'a farklı yanıtlar verir. Her zaman:
- Parse edebiliyor musun? (JSON validity)
- İçerik beklentini karşılıyor mu? (schema validation)
- Downstream sistem işleyebiliyor mu? (render/match validation)

### 2. Threshold-Based Verdicts, Not Binary
LLM-dependent testlerde %100 başarı beklemek gerçekçi değil. Kabul eşiği koy:
- **Pass:** 80%+ (4/5, 8/10)
- **Partial:** 60%+ (3/5, 6/10)
- **Fail:** <60%

### 3. Prompt'u Programatik Doğrulama İçin Şekillendir
LLM çıktısını kod ile doğrulayacaksan, prompt'a format constraint ekle:
- "Sayıları rakamla yaz"
- "JSON dışında hiçbir şey yazma"
- "İçeriği aynen tekrarla"
Bu, downstream matching/parsing başarısını dramatik artırır.

### 4. Retry > Complex Prompt Engineering
JSON parse hatası aldığında, prompt'u karmaşıklaştırmak yerine aynı prompt'u bir kez daha gönder. LLM'in stochastic doğası retry'ı etkili kılıyor. Tek retry yeterli, 3+ retry diminishing returns.

### 5. Server Restart Gotcha
Yeni endpoint eklediysen ve `uvicorn --reload` kullanmıyorsan, server'ı yeniden başlatmayı unutma. 404 alan bir endpoint "kod yanlış" değil, "server eski kodu çalıştırıyor" olabilir. Geliştirme ortamında her zaman `--reload` flag'i kullan.

### 6. Separation of Concerns: Index Resolution
İndeks hesaplamaları (son eleman, ortadaki eleman, n'inci tip) frontend'in sorumluluğu. Backend'e sadece geçerli tam sayı indeks gönder. Backend sınır kontrolü yapsın, ama indeks çözümleme mantığı backend'de olmasın.

### 7. Ack Before Cleanup
Kullanıcıya "seni duydum" sinyalini, arka plan işlemleri tamamlanmadan önce gönder. Algılanan gecikme, gerçek gecikmeden daha önemli. Async task cancellation 100-200ms sürebilir — bu süre boyunca kullanıcıyı belirsizlikte bırakma. Önce ack, sonra cleanup.

### 8. Platform Özelliklerini Kapat Değil, Aç
Tarayıcının/OS'in sunduğu sinyal işleme özelliklerini (AEC, noise suppression, AGC) kapatıp kendin yazmaya çalışma. Bu özellikler yıllarca optimize edilmiş, senin birkaç satır kodun daha iyi olmayacak. Aç ve üzerine inşa et. Test 3'te AEC'yi açmak, tüm VAD threshold sorunlarını kökünden çözdü.

### 9. Sliding Window > Timer Debounce (Sinyal İşleme)
Ses/sinyal işlemede timer-based debounce yerine sliding window kullan. Window-based yaklaşım: (1) kısa patlamaları (öksürük, kapı) doğal olarak filtreliyor, (2) sürekli sinyali hemen algılıyor, (3) parametreleri bağımsız tune edebiliyorsun (window size, trigger count, threshold). Timer debounce ise ya çok geç tetikleniyor ya da false positive veriyor.
