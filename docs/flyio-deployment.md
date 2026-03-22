# Fly.io Deployment: Test & Prod Ortamları

## Context

MyTeacher (Türkçe ilkokul öğretmen uygulaması) şu an sadece local'de çalışıyor. PoC'yi tamamlamak için bir test ortamına ihtiyaç var. Hedef:
- **Test (preprod)**: Düşük maliyetli, hemen deploy. PoC burada tamamlanacak.
- **Prod**: İleride, test başarılı olursa. Şimdilik sadece planlanacak, deploy edilmeyecek.
- Her iki ortam PostgreSQL kullanacak (mevcut SQLite yerine).
- Local dev SQLite ile çalışmaya devam edecek (dual-driver).

## Mevcut Durum

- **DB**: SQLite (better-sqlite3 + Drizzle ORM), tek tablo `lesson_topics`
- **Server**: Raw Node.js HTTP + ws WebSocket, PORT=3001
- **Client**: Vite React, dev proxy ile /ws ve /api server'a yönleniyor
- **Build**: `pnpm build` → shared → server (tsc) → client (vite build)
- **Docker/Fly config**: Yok, sıfırdan oluşturulacak

## Mimari Kararlar

1. **Tek Fly app** — Server hem API/WS hem client static dosyalarını serve edecek
2. **Dual DB driver** — Local dev SQLite, deploy PostgreSQL. `DATABASE_URL` formatına göre otomatik seçim
3. **Fly Postgres** — Managed PG, test için minimal plan
4. **Region**: `ams` (Amsterdam) — Türkiye'ye en yakın Fly bölgesi
5. **Auto-stop**: Test'te `suspend` (maliyet tasarrufu), prod'da `off`

---

## Faz 1: SQLite → PostgreSQL Dual-Driver Desteği

### 1.1 Bağımlılık değişiklikleri — `server/package.json`

```diff
+ "postgres": "^3.4.0"        # PostgreSQL driver (postgres.js — lightweight, no native deps)
  "better-sqlite3": "..."     # Kalacak (local dev için)
  "drizzle-orm": "..."        # Kalacak
```

### 1.2 PG schema — `server/src/db/schema.pg.ts` (yeni dosya)

Mevcut `schema.ts` (SQLite) kalacak. Yeni PG schema:

```typescript
import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";

export const lessonTopics = pgTable("lesson_topics", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  gradeLevel: integer("grade_level").notNull(),
  subject: text("subject").notNull(),
  boardItems: text("board_items").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export type LessonTopic = typeof lessonTopics.$inferSelect;
export type NewLessonTopic = typeof lessonTopics.$inferInsert;
```

Farklar: `sqliteTable` → `pgTable`, `integer("is_active", { mode: "boolean" })` → `boolean("is_active")`.

### 1.3 DB connection — `server/src/db/index.ts` (yeniden yaz)

DATABASE_URL formatına göre SQLite veya PG seçimi:

```typescript
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import * as sqliteSchema from "./schema.js";
import * as pgSchema from "./schema.pg.js";

const DATABASE_URL = process.env.DATABASE_URL || "myteacher.db";
const isPg = DATABASE_URL.startsWith("postgres");

if (isPg) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(DATABASE_URL);
  db = drizzlePg(sql, { schema: pgSchema });
  // Auto-create table via SQL
} else {
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma("journal_mode = WAL");
  db = drizzleSqlite(sqlite, { schema: sqliteSchema });
  // Auto-create table via SQL
}
```

### 1.4 Repository — `server/src/db/repository.ts` (async'e çevir)

Tüm fonksiyonlar `async` olacak (PG async):

```typescript
export async function listActiveTopics(): Promise<LessonTopic[]> { ... }
export async function getTopicById(id: string): Promise<LessonTopic | undefined> { ... }
export async function createTopic(...): Promise<LessonTopic> { ... }
export async function updateTopic(...): Promise<LessonTopic | undefined> { ... }
export async function deleteTopic(id: string): Promise<boolean> { ... }
```

### 1.5 Caller'ları güncelle

**`server/src/api/topics.ts`**: Zaten async handler, sadece `await` ekle:
- `listAllTopics()` → `await listAllTopics()`
- `getTopicById(...)` → `await getTopicById(...)`
- `createTopic(...)` → `await createTopic(...)`
- `updateTopic(...)` → `await updateTopic(...)`
- `deleteTopic(...)` → `await deleteTopic(...)`

**`server/src/ws/handler.ts`** (satır 870):
- `getTopicById(msg.topicId)` → `await getTopicById(msg.topicId)`

### 1.6 Server entry — `server/src/index.ts`

DB init artık async olduğu için top-level await:
```typescript
import './env.js';
await import('./db/index.js');
```

---

## Faz 2: Static File Serving + WebSocket Keepalive

### 2.1 Static file serving — `server/src/index.ts`

Production'da `client/dist/` dosyalarını serve et:

```typescript
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const STATIC_DIR = join(import.meta.dirname, '../../client/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

// httpServer handler'da, API route'larından sonra:
// 1. Static dosya dene (STATIC_DIR + req.url)
// 2. Bulamazsa index.html döndür (SPA fallback)
```

### 2.2 WebSocket ping/pong — `server/src/index.ts`

Fly proxy idle connection'ları kapatır. Ping/pong ile canlı tut:

```typescript
const PING_INTERVAL = 30_000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!(ws as any).isAlive) { ws.terminate(); return; }
    (ws as any).isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('connection', (ws) => {
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });
  handleConnection(ws);
});
```

---

## Faz 3: Docker & Fly Config

### 3.1 `.dockerignore` (yeni)

```
node_modules
.env
*.db
*.db-shm
*.db-wal
.git
.claude
.vite
*.tsbuildinfo
```

### 3.2 `Dockerfile` (yeni, multi-stage)

```dockerfile
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/client/node_modules ./client/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY . .
RUN pnpm build

FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/

EXPOSE 3001
CMD ["node", "server/dist/index.js"]
```

### 3.3 `fly.toml` — Test ortamı

```toml
app = "myteacher-test"
primary_region = "ams"

[build]

[env]
  NODE_ENV = "production"
  PORT = "3001"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

### 3.4 `fly.prod.toml` — Prod ortamı (ileride kullanılacak)

```toml
app = "myteacher-prod"
primary_region = "ams"

[build]

[env]
  NODE_ENV = "production"
  PORT = "3001"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

---

## Faz 4: Deploy Komutları (Test)

```bash
# 1. Fly app oluştur
fly apps create myteacher-test

# 2. Fly Postgres oluştur (minimal — test için)
fly postgres create --name myteacher-test-db --region ams \
  --vm-size shared-cpu-1x --initial-cluster-size 1 --volume-size 1

# 3. DB'yi app'e bağla (DATABASE_URL otomatik set edilir)
fly postgres attach myteacher-test-db --app myteacher-test

# 4. Secrets ayarla
fly secrets set --app myteacher-test \
  GOOGLE_API_KEY="..." \
  ANTHROPIC_API_KEY="..." \
  DEEPGRAM_API_KEY="..." \
  CARTESIA_API_KEY="..." \
  CARTESIA_VOICE_ID="..." \
  LLM_PROVIDER="google"

# 5. Deploy
fly deploy --app myteacher-test
```

---

## Shared Package Export Düzeltmesi

`shared/package.json` exports'u `./src/protocol.ts`'e işaret ediyor. Production build'de `dist/` kullanılması gerekiyor. Conditional export:

```json
{
  "exports": {
    ".": {
      "import": "./dist/protocol.js",
      "types": "./dist/protocol.d.ts",
      "default": "./src/protocol.ts"
    }
  }
}
```

---

## Maliyet Tahmini (Test)

| Kaynak | Spec | Aylık |
|--------|------|-------|
| App Machine (shared-cpu-1x, 512MB) | auto_stop=suspend | ~$1.60 |
| Fly Postgres (shared-cpu-1x, 256MB, 1GB) | Sürekli çalışır | ~$3.30 |
| **Toplam** | | **~$5/ay** |

Fly free tier (3 shared VM) bunu büyük ölçüde karşılayabilir.

---

## Dosya Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/src/db/schema.pg.ts` | Yeni | PostgreSQL Drizzle schema |
| `server/src/db/index.ts` | Değişiklik | Dual-driver (SQLite/PG) seçimi |
| `server/src/db/repository.ts` | Değişiklik | Tüm fonksiyonlar async |
| `server/src/api/topics.ts` | Değişiklik | await ekle |
| `server/src/ws/handler.ts` | Değişiklik | await getTopicById + ping/pong |
| `server/src/index.ts` | Değişiklik | Static serving + WS keepalive |
| `server/package.json` | Değişiklik | postgres dependency ekle |
| `shared/package.json` | Değişiklik | Export paths düzelt (dist/) |
| `Dockerfile` | Yeni | Multi-stage build |
| `.dockerignore` | Yeni | Docker ignore rules |
| `fly.toml` | Yeni | Test ortam config |
| `fly.prod.toml` | Yeni | Prod ortam config (ileride) |

## Uygulama Sırası

1. `postgres` dependency ekle, `schema.pg.ts` oluştur
2. `db/index.ts` dual-driver'a çevir
3. `repository.ts` async'e çevir
4. `topics.ts` ve `handler.ts`'de await ekle
5. `index.ts`'e static serving + ping/pong ekle
6. `shared/package.json` exports düzelt
7. Testleri çalıştır: `cd server && npm test`
8. `Dockerfile`, `.dockerignore`, `fly.toml`, `fly.prod.toml` oluştur
9. Local Docker build test: `docker build -t myteacher .`
10. Fly deploy komutları ile test ortamına deploy

## Doğrulama

1. `cd server && npm test` — mevcut 44 test geçmeli (SQLite driver ile)
2. `docker build -t myteacher .` — başarılı build
3. Deploy sonrası:
   - `curl https://myteacher-test.fly.dev/api/topics` → 200
   - `npx wscat -c wss://myteacher-test.fly.dev/ws` → bağlantı başarılı
   - Tarayıcıda `https://myteacher-test.fly.dev` → React app yükleniyor
   - Admin panelden ders oluştur → WebSocket ile çalışıyor
