import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";

export const lessonTopics = pgTable("lesson_topics", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  gradeLevel: integer("grade_level").notNull(),
  subject: text("subject").notNull(),
  boardItems: text("board_items").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type LessonTopic = typeof lessonTopics.$inferSelect;
export type NewLessonTopic = typeof lessonTopics.$inferInsert;
