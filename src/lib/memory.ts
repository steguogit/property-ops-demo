import { randomUUID } from "crypto";
import {
  getConversationsCollection,
  getConversationMessagesCollection,
  ConversationDoc,
  ConversationMessageDoc,
} from "./mongo";
import { env, isAtlasEmbedding, hasVoyage, hasLLM } from "./env";
import { voyageEmbed, voyageEmbedOne } from "./voyage";

// ---------------------------------------------------------------------------
// Conversational memory management (all in MongoDB).
//
//   * conversations         — one doc per chat thread
//   * conversation_messages — one doc per turn, each semantically embedded
//
// Past turns can be recalled by semantic vector search, keyword ($search), or a
// hybrid of both — so an ongoing chat can pull in relevant earlier context even
// when it scrolled far out of the recent window.
// ---------------------------------------------------------------------------

function preview(text: string, n = 140): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** A past message recalled from memory, with its relevance score. */
export interface RecalledMessage {
  conversationId: string;
  messageIndex: number;
  role: "user" | "assistant";
  messageText: string;
  createdAt: string;
  score: number;
  /** "semantic" | "keyword" | "hybrid" */
  via: string;
}

// ----- Conversation lifecycle -----

export async function createConversation(
  title?: string,
  opts: { userId?: string; tenantId?: string } = {}
): Promise<ConversationDoc> {
  const col = await getConversationsCollection();
  const now = new Date().toISOString();
  const conversationId = `CONV-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const doc: ConversationDoc = {
    _id: conversationId,
    conversationId,
    title: title?.trim() || "New conversation",
    userId: opts.userId,
    tenantId: opts.tenantId ?? env.defaultTenantId,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(doc as any);
  return doc;
}

export async function listConversations(
  limit = 50
): Promise<ConversationDoc[]> {
  const col = await getConversationsCollection();
  return col.find({}).sort({ updatedAt: -1 }).limit(limit).toArray();
}

export async function getConversation(
  conversationId: string
): Promise<ConversationDoc | null> {
  const col = await getConversationsCollection();
  return col.findOne({ conversationId });
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const convCol = await getConversationsCollection();
  const msgCol = await getConversationMessagesCollection();
  await msgCol.deleteMany({ conversationId });
  await convCol.deleteOne({ conversationId });
}

/** Rename a conversation (marks it as human-titled so auto-title won't overwrite). */
export async function renameConversation(
  conversationId: string,
  title: string
): Promise<void> {
  const col = await getConversationsCollection();
  await col.updateOne(
    { conversationId },
    {
      $set: {
        title: title.trim() || "Untitled",
        autoTitled: false,
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

/**
 * Search conversations by title / last-message-preview keyword (case-insensitive
 * substring). Simple, deterministic, and CJK-friendly.
 */
export async function searchConversations(
  q: string,
  limit = 50
): Promise<ConversationDoc[]> {
  const col = await getConversationsCollection();
  const term = q.trim();
  if (!term) return listConversations(limit);
  const rx = new RegExp(
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i"
  );
  return col
    .find({ $or: [{ title: rx }, { lastMessagePreview: rx }] })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Auto-generate a short topic title from the conversation's content using the
 * LLM. Best-effort: skips if no LLM, if the user already renamed it, or on any
 * error. Falls back to a truncated first user message.
 */
export async function generateConversationTitle(
  conversationId: string
): Promise<void> {
  const convCol = await getConversationsCollection();
  const conv = await convCol.findOne({ conversationId });
  if (!conv) return;
  // Never overwrite a human-set title.
  if (conv.autoTitled === false && conv.title && conv.title !== "New conversation")
    return;

  const msgs = await getMessages(conversationId);
  if (!msgs.length) return;
  const firstUser =
    msgs.find((m) => m.role === "user")?.messageText ?? msgs[0].messageText;

  let title = "";
  if (hasLLM()) {
    try {
      const transcript = msgs
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.messageText}`)
        .join("\n")
        .slice(0, 2000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (env.llmAuthHeader === "api-key") headers["api-key"] = env.llmApiKey;
      else headers["Authorization"] = `Bearer ${env.llmApiKey}`;
      const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: env.llmModel,
          messages: [
            {
              role: "system",
              content:
                "Generate a concise topic title (3-6 words, no quotes, no trailing punctuation) for this conversation. " +
                "Match the primary language of the conversation (English or Chinese). Output ONLY the title.",
            },
            { role: "user", content: transcript },
          ],
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        title = (json.choices?.[0]?.message?.content ?? "")
          .trim()
          .replace(/^["'「」]+|["'「」]+$/g, "")
          .replace(/[.。!！?？]+$/g, "")
          .slice(0, 80);
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  if (!title) {
    title = firstUser.replace(/\s+/g, " ").trim().slice(0, 48);
    if (firstUser.length > 48) title += "…";
  }
  if (!title) return;

  await convCol.updateOne(
    { conversationId },
    {
      $set: {
        title,
        autoTitled: true,
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

/** Full ordered transcript of a conversation. */
export async function getMessages(
  conversationId: string
): Promise<ConversationMessageDoc[]> {
  const col = await getConversationMessagesCollection();
  return col
    .find({ conversationId })
    .sort({ messageIndex: 1 })
    .toArray();
}

/** The most-recent N turns, in chronological order (for the LLM window). */
export async function getRecentMessages(
  conversationId: string,
  n = 8
): Promise<ConversationMessageDoc[]> {
  const col = await getConversationMessagesCollection();
  const recentDesc = await col
    .find({ conversationId })
    .sort({ messageIndex: -1 })
    .limit(n)
    .toArray();
  return recentDesc.reverse();
}

// ----- Appending messages (with embedding) -----

/**
 * Append one turn to a conversation. The message text is embedded (explicit
 * Voyage strategy) or left for Atlas auto-embedding, then stored. The parent
 * conversation's counters + preview are updated.
 */
export async function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  messageText: string,
  opts: { sourceDocIds?: string[] } = {}
): Promise<ConversationMessageDoc> {
  const convCol = await getConversationsCollection();
  const msgCol = await getConversationMessagesCollection();
  const now = new Date().toISOString();

  const conv = await convCol.findOne({ conversationId });
  const messageIndex = conv?.messageCount ?? 0;

  const doc: ConversationMessageDoc = {
    _id: `${conversationId}#${messageIndex}`,
    conversationId,
    messageIndex,
    role,
    messageText,
    createdAt: now,
    sourceDocIds: opts.sourceDocIds,
  };

  // Explicit-vector strategies embed client-side; Atlas auto-embed handles the
  // `messageText` field server-side (no client vector needed).
  if (!isAtlasEmbedding() && hasVoyage() && messageText.trim()) {
    try {
      const [v] = await voyageEmbed([messageText], "document");
      doc.embedding = v;
    } catch {
      /* memory still works without a stored vector (keyword recall) */
    }
  }

  await msgCol.insertOne(doc as any);
  await convCol.updateOne(
    { conversationId },
    {
      $set: {
        updatedAt: now,
        lastMessagePreview: `${role === "user" ? "🧑 " : "🤖 "}${preview(messageText)}`,
      },
      $inc: { messageCount: 1 },
    }
  );
  return doc;
}

// ----- Recall past turns (semantic / keyword / hybrid) -----

function toRecalled(d: any, via: string, score: number): RecalledMessage {
  return {
    conversationId: d.conversationId,
    messageIndex: d.messageIndex,
    role: d.role,
    messageText: d.messageText,
    createdAt: d.createdAt,
    score,
    via,
  };
}

const MSG_PROJECT = {
  _id: 0,
  conversationId: 1,
  messageIndex: 1,
  role: 1,
  messageText: 1,
  createdAt: 1,
} as const;

/** Semantic recall via $vectorSearch over message embeddings. */
export async function recallSemantic(
  query: string,
  limit = 5,
  opts: { conversationId?: string; excludeConversationId?: string } = {}
): Promise<RecalledMessage[]> {
  const col = await getConversationMessagesCollection();

  const stage: Record<string, unknown> = {
    index: env.convVectorIndex,
    numCandidates: 100,
    limit: limit * 3,
  };
  if (isAtlasEmbedding()) {
    stage.path = "messageText";
    stage.query = query;
  } else {
    stage.path = "embedding";
    stage.queryVector = await voyageEmbedOne(query, "query");
  }

  const pipeline: Record<string, unknown>[] = [{ $vectorSearch: stage }];
  const match = buildScopeMatch(opts);
  if (match) pipeline.push({ $match: match });
  pipeline.push(
    { $limit: limit },
    { $project: { ...MSG_PROJECT, score: { $meta: "vectorSearchScore" } } }
  );

  const docs = await col.aggregate(pipeline).toArray();
  return docs.map((d: any) => toRecalled(d, "semantic", d.score ?? 0));
}

/** Keyword recall via $search (Atlas Search) over messageText. */
export async function recallKeyword(
  query: string,
  limit = 5,
  opts: { conversationId?: string; excludeConversationId?: string } = {}
): Promise<RecalledMessage[]> {
  const col = await getConversationMessagesCollection();
  const pipeline: Record<string, unknown>[] = [
    {
      $search: {
        index: env.convSearchIndex,
        text: { query, path: "messageText", fuzzy: { maxEdits: 1 } },
      },
    },
  ];
  const match = buildScopeMatch(opts);
  if (match) pipeline.push({ $match: match });
  pipeline.push(
    { $limit: limit },
    { $project: { ...MSG_PROJECT, score: { $meta: "searchScore" } } }
  );

  const docs = await col.aggregate(pipeline).toArray();
  return docs.map((d: any) => toRecalled(d, "keyword", d.score ?? 0));
}

function buildScopeMatch(opts: {
  conversationId?: string;
  excludeConversationId?: string;
}): Record<string, unknown> | null {
  if (opts.conversationId) return { conversationId: opts.conversationId };
  if (opts.excludeConversationId)
    return { conversationId: { $ne: opts.excludeConversationId } };
  return null;
}

/**
 * Hybrid recall: run semantic + keyword in parallel and merge with a simple
 * reciprocal-rank fusion, so the strongest memories from either signal surface.
 */
export async function recallMemory(
  query: string,
  limit = 5,
  opts: { conversationId?: string; excludeConversationId?: string } = {}
): Promise<RecalledMessage[]> {
  const [sem, kw] = await Promise.all([
    recallSemantic(query, limit, opts).catch(() => [] as RecalledMessage[]),
    recallKeyword(query, limit, opts).catch(() => [] as RecalledMessage[]),
  ]);

  const K = 60;
  const fused = new Map<string, { m: RecalledMessage; score: number }>();
  const add = (list: RecalledMessage[]) => {
    list.forEach((m, rank) => {
      const key = `${m.conversationId}#${m.messageIndex}`;
      const rr = 1 / (K + rank + 1);
      const prev = fused.get(key);
      if (prev) {
        prev.score += rr;
        prev.m.via = "hybrid";
      } else {
        fused.set(key, { m: { ...m, via: m.via }, score: rr });
      }
    });
  };
  add(sem);
  add(kw);

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.m, score: x.score }));
}
