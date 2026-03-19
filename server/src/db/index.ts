import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = process.env.DATABASE_URL || "myteacher.db";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Auto-create tables on first import (dev convenience)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS lesson_topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    grade_level INTEGER NOT NULL,
    subject TEXT NOT NULL,
    board_items TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

console.log("[db] SQLite ready:", DB_PATH);
