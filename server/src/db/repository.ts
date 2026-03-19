import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "./index.js";
import { lessonTopics, type LessonTopic, type NewLessonTopic } from "./schema.js";

export function listActiveTopics(): LessonTopic[] {
  return db.select().from(lessonTopics).where(eq(lessonTopics.isActive, true)).all();
}

export function listAllTopics(): LessonTopic[] {
  return db.select().from(lessonTopics).all();
}

export function getTopicById(id: string): LessonTopic | undefined {
  return db.select().from(lessonTopics).where(eq(lessonTopics.id, id)).get();
}

export function createTopic(data: Omit<NewLessonTopic, "id" | "createdAt" | "updatedAt">): LessonTopic {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.insert(lessonTopics).values({ ...data, id, createdAt: now, updatedAt: now }).run();
  return getTopicById(id)!;
}

export function updateTopic(
  id: string,
  data: Partial<Pick<NewLessonTopic, "title" | "description" | "gradeLevel" | "subject" | "boardItems" | "isActive">>,
): LessonTopic | undefined {
  const now = new Date().toISOString();
  db.update(lessonTopics).set({ ...data, updatedAt: now }).where(eq(lessonTopics.id, id)).run();
  return getTopicById(id);
}

export function deleteTopic(id: string): boolean {
  const result = db.delete(lessonTopics).where(eq(lessonTopics.id, id)).run();
  return result.changes > 0;
}
