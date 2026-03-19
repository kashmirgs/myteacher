import * as sqliteSchema from "./schema.js";
import * as pgSchema from "./schema.pg.js";

const DATABASE_URL = process.env.DATABASE_URL || "myteacher.db";
const isPg = DATABASE_URL.startsWith("postgres");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle SQLite/PG APIs are compatible at runtime
let db: any;
let schema: typeof sqliteSchema | typeof pgSchema;

if (isPg) {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const sql = postgres(DATABASE_URL);
  schema = pgSchema;
  db = drizzle(sql, { schema: pgSchema });
  await sql`CREATE TABLE IF NOT EXISTS lesson_topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    grade_level INTEGER NOT NULL,
    subject TEXT NOT NULL,
    board_items TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  console.log("[db] PostgreSQL ready");
} else {
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const Database = (await import("better-sqlite3")).default;
  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma("journal_mode = WAL");
  schema = sqliteSchema;
  db = drizzle(sqlite, { schema: sqliteSchema });
  sqlite.exec(`CREATE TABLE IF NOT EXISTS lesson_topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    grade_level INTEGER NOT NULL,
    subject TEXT NOT NULL,
    board_items TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  console.log("[db] SQLite ready:", DATABASE_URL);
}

export { db, schema };
