import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db, schema } from "./index.js";
import type { LessonTopic, NewLessonTopic } from "./schema.js";

const { lessonTopics } = schema;

export async function listActiveTopics(): Promise<LessonTopic[]> {
  return db.select().from(lessonTopics).where(eq(lessonTopics.isActive, true));
}

export async function listAllTopics(): Promise<LessonTopic[]> {
  return db.select().from(lessonTopics);
}

export async function getTopicById(id: string): Promise<LessonTopic | undefined> {
  const rows = await db.select().from(lessonTopics).where(eq(lessonTopics.id, id));
  return rows[0];
}

export async function createTopic(data: Omit<NewLessonTopic, "id" | "createdAt" | "updatedAt">): Promise<LessonTopic> {
  const id = uuidv4();
  const now = new Date().toISOString();
  await db.insert(lessonTopics).values({ ...data, id, createdAt: now, updatedAt: now });
  return (await getTopicById(id))!;
}

export async function updateTopic(
  id: string,
  data: Partial<Pick<NewLessonTopic, "title" | "description" | "gradeLevel" | "subject" | "boardItems" | "isActive">>,
): Promise<LessonTopic | undefined> {
  const now = new Date().toISOString();
  await db.update(lessonTopics).set({ ...data, updatedAt: now }).where(eq(lessonTopics.id, id));
  return await getTopicById(id);
}

export async function deleteTopic(id: string): Promise<boolean> {
  const rows = await db.delete(lessonTopics).where(eq(lessonTopics.id, id)).returning();
  return rows.length > 0;
}
