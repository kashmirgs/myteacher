import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listActiveTopics,
  listAllTopics,
  getTopicById,
  createTopic,
  updateTopic,
  deleteTopic,
} from "../db/repository.js";
import { createLLMService, type LLMService, type LessonBoardItem } from "../services/claude.js";

let _llm: LLMService | null = null;
function getLLM(): LLMService {
  if (!_llm) _llm = createLLMService();
  return _llm;
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/**
 * Handle /api/topics routes. Returns true if the request was handled.
 */
export async function handleTopicsAPI(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS headers for dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS" && path.startsWith("/api/topics")) {
    res.writeHead(204);
    res.end();
    return true;
  }

  // POST /api/topics/generate — LLM-generate board items for a topic
  if (method === "POST" && path === "/api/topics/generate") {
    try {
      const body = JSON.parse(await readBody(req));
      const { topic, gradeLevel, length, includeQuestions, examStyle } = body as {
        topic: string; gradeLevel?: number; length?: string;
        includeQuestions?: boolean; examStyle?: boolean;
      };
      if (!topic) {
        json(res, { error: "topic is required" }, 400);
        return true;
      }
      const llm = getLLM();
      const validLength = (length === "short" || length === "medium" || length === "long") ? length : undefined;
      const questionOpts = includeQuestions ? { includeQuestions, examStyle } : undefined;
      const boardItems: LessonBoardItem[] = await llm.generateLesson(topic, gradeLevel, validLength, questionOpts);
      json(res, { boardItems });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[api] generate error:", msg);
      json(res, { error: msg }, 500);
    }
    return true;
  }

  // GET /api/topics — list topics
  if (method === "GET" && path === "/api/topics") {
    const all = url.searchParams.get("all") === "true";
    const topics = all ? await listAllTopics() : await listActiveTopics();
    // Return summary (without full board_items) for listing
    const summary = topics.map(({ boardItems: _bi, ...rest }) => rest);
    json(res, summary);
    return true;
  }

  // GET /api/topics/:id
  const singleMatch = path.match(/^\/api\/topics\/([a-f0-9-]+)$/);
  if (method === "GET" && singleMatch) {
    const topic = await getTopicById(singleMatch[1]);
    if (!topic) {
      json(res, { error: "not found" }, 404);
    } else {
      json(res, topic);
    }
    return true;
  }

  // POST /api/topics — create topic
  if (method === "POST" && path === "/api/topics") {
    try {
      const body = JSON.parse(await readBody(req));
      const { title, description, gradeLevel, subject, boardItems, isActive } = body;
      if (!title || !subject || !boardItems || gradeLevel == null) {
        json(res, { error: "title, subject, gradeLevel, boardItems are required" }, 400);
        return true;
      }
      const topic = await createTopic({
        title,
        description: description ?? null,
        gradeLevel,
        subject,
        boardItems: typeof boardItems === "string" ? boardItems : JSON.stringify(boardItems),
        isActive: isActive ?? true,
      });
      json(res, topic, 201);
    } catch (err) {
      console.error("[api] create error:", err);
      json(res, { error: "create failed" }, 500);
    }
    return true;
  }

  // PUT /api/topics/:id
  if (method === "PUT" && singleMatch) {
    try {
      const body = JSON.parse(await readBody(req));
      if (body.boardItems && typeof body.boardItems !== "string") {
        body.boardItems = JSON.stringify(body.boardItems);
      }
      const topic = await updateTopic(singleMatch[1], body);
      if (!topic) {
        json(res, { error: "not found" }, 404);
      } else {
        json(res, topic);
      }
    } catch (err) {
      console.error("[api] update error:", err);
      json(res, { error: "update failed" }, 500);
    }
    return true;
  }

  // DELETE /api/topics/:id
  if (method === "DELETE" && singleMatch) {
    const ok = await deleteTopic(singleMatch[1]);
    if (!ok) {
      json(res, { error: "not found" }, 404);
    } else {
      json(res, { ok: true });
    }
    return true;
  }

  return false;
}
