import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const lessonTopics = sqliteTable("lesson_topics", {
  id: text("id").primaryKey(), // UUID
  title: text("title").notNull(),
  description: text("description"),
  gradeLevel: integer("grade_level").notNull(), // 1-4
  subject: text("subject").notNull(),
  boardItems: text("board_items").notNull(), // JSON string of LessonBoardItem[]
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type LessonTopic = typeof lessonTopics.$inferSelect;
export type NewLessonTopic = typeof lessonTopics.$inferInsert;
