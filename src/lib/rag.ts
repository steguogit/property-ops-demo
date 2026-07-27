import { env, hasLLM } from "./env";
import { SearchHit, runSearchEnhanced, RetrievalMode } from "./retrieval";
import { getCollection } from "./mongo";
import {
  AppliedCorrections,
  correctionsContextBlock,
  correctionsForQuery,
} from "./corrections";
import { ResolvedPolicyPlan, resolvePolicies } from "./policy-resolver";
import {
  appendMessage,
  getRecentMessages,
  recallMemory,
  RecalledMessage,
} from "./memory";

export interface RagResult {
  answer: string;
  mode: RetrievalMode;
  llmUsed: boolean;
  sources: SearchHit[];
  appliedCorrections?: AppliedCorrections | null;
  expandedAliases?: string[];
  /** The deterministic policy plan applied to this query (authoritative). */
  policyPlan?: ResolvedPolicyPlan | null;
  /** Id of the PolicyApplicationTrace persisted for this query. */
  traceId?: string | null;
}

/**
 * Build the authoritative grounding block from an approved-policy plan. Term
 * meanings and answer instructions come from HUMAN-APPROVED policies — the LLM
 * must treat these as authoritative and must NOT override them.
 */
function policyGroundingBlock(plan: ResolvedPolicyPlan | null): string {
  if (!plan) return "";
  const lines: string[] = [];
  if (plan.termMeanings.length) {
    lines.push("Approved term meanings (authoritative — apply exactly):");
    for (const t of plan.termMeanings) {
      lines.push(`- "${t.term}" means: ${t.meaning}`);
    }
  }
  if (plan.answerInstructions.length) {
    lines.push("Approved answer instructions (authoritative):");
    for (const a of plan.answerInstructions) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}

function buildContext(hits: SearchHit[]): string {
  return hits
    .map(
      (h, i) =>
        `[#${i + 1}] (${h.docId}, ${h.docType}, property: ${h.propertyName})\nTitle: ${h.title}\n${h.chunkText}`
    )
    .join("\n\n");
}

/** Extractive fallback when no LLM key is configured. */
function extractiveAnswer(query: string, hits: SearchHit[]): string {
  if (!hits.length) return "No relevant records were found in the corpus.";
  const top = hits.slice(0, 3);
  const lines = top.map(
    (h, i) =>
      `${i + 1}. ${h.title} (${h.docId}) — ${h.chunkText.slice(0, 280)}${
        h.chunkText.length > 280 ? "…" : ""
      }`
  );
  return (
    `Based on the retrieved records (no LLM key configured — showing extractive summary):\n\n` +
    lines.join("\n\n") +
    `\n\nSources: ${top.map((h) => h.docId).join(", ")}.`
  );
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function llmAnswer(
  query: string,
  hits: SearchHit[],
  corrections?: AppliedCorrections | null,
  policyPlan?: ResolvedPolicyPlan | null,
  extra?: {
    /** Prior turns of THIS conversation, chronological (recent window). */
    history?: ChatTurn[];
    /** Relevant older turns recalled from memory (semantic/keyword). */
    recalledContext?: string;
  }
): Promise<string> {
  const context = buildContext(hits);
  const conversational = !!extra?.history?.length || !!extra?.recalledContext;
  const system =
    "You are an internal operations assistant for a property-management company. " +
    "Answer ONLY from the provided context. Be concise and precise. " +
    "Cite the supporting sources inline using their docId in brackets, e.g. [SOP-WATER-RES-001]. " +
    "Prefer the newest / non-obsolete version of a procedure when versions differ. " +
    "Approved term meanings and answer instructions are AUTHORITATIVE: apply them exactly and never override them with your own interpretation. " +
    (conversational
      ? "This is a multi-turn conversation: use the prior turns and recalled memory to resolve references like 'it', 'that', 'the previous one'. "
      : "") +
    "If the context does not contain the answer, say so. Handle English and Chinese property names/aliases correctly.";

  // Authoritative approved-policy grounding takes precedence over the legacy
  // correction overlay.
  const policyBlock = policyGroundingBlock(policyPlan ?? null);
  const correctionBlock = corrections
    ? correctionsContextBlock(corrections)
    : "";

  const user =
    `Question: ${query}\n\n` +
    (policyBlock ? `${policyBlock}\n\n` : "") +
    (correctionBlock ? `${correctionBlock}\n\n` : "") +
    (extra?.recalledContext
      ? `Relevant earlier conversation memory:\n${extra.recalledContext}\n\n`
      : "") +
    `Context records:\n${context}\n\nProvide a grounded answer with inline [docId] citations.`;

  // Grove gateway uses an `api-key` header; OpenAI-compatible uses Bearer.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.llmAuthHeader === "api-key") {
    headers["api-key"] = env.llmApiKey;
  } else {
    headers["Authorization"] = `Bearer ${env.llmApiKey}`;
  }

  // Recent conversation turns are sent as real chat messages so the model has
  // natural dialogue context; the current question (with grounding) is last.
  const messages = [
    { role: "system", content: system },
    ...(extra?.history ?? []),
    { role: "user", content: user },
  ];

  const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.llmModel,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM error ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices[0]?.message?.content ?? "(no answer)";
}

/**
 * RAG: retrieve with the best available mode (rerank if Voyage present,
 * else hybrid), then generate a grounded answer.
 */
export async function runRag(
  query: string,
  limit = 6,
  opts: {
    includeObsolete?: boolean;
    policyContext?: import("./policy-resolver").QueryContext;
  } = {}
): Promise<RagResult> {
  let mode: RetrievalMode;
  let hits: SearchHit[];
  let appliedCorrections: AppliedCorrections | null = null;
  let expandedAliases: string[] = [];
  let policyPlan: ResolvedPolicyPlan | null = null;
  let traceId: string | null = null;

  // Version-aware + policy-aware + correction-aware retrieval. Prefer rerank,
  // fall back to hybrid if the reranker is unavailable.
  try {
    const r = await runSearchEnhanced("rerank", query, limit, {
      includeObsolete: opts.includeObsolete,
      policyContext: opts.policyContext,
    });
    hits = r.hits;
    appliedCorrections = r.appliedCorrections;
    expandedAliases = r.expandedAliases;
    policyPlan = r.policyPlan;
    traceId = r.traceId;
    mode = "rerank";
  } catch {
    const r = await runSearchEnhanced("hybrid", query, limit, {
      includeObsolete: opts.includeObsolete,
      policyContext: opts.policyContext,
    });
    hits = r.hits;
    appliedCorrections = r.appliedCorrections;
    expandedAliases = r.expandedAliases;
    policyPlan = r.policyPlan;
    traceId = r.traceId;
    mode = "hybrid";
  }

  let answer: string;
  let llmUsed = false;
  if (hasLLM()) {
    try {
      answer = await llmAnswer(query, hits, appliedCorrections, policyPlan);
      llmUsed = true;
    } catch (e) {
      answer =
        extractiveAnswer(query, hits) +
        `\n\n(Note: LLM call failed: ${(e as Error).message})`;
    }
  } else {
    answer = extractiveAnswer(query, hits);
  }

  return {
    answer,
    mode,
    llmUsed,
    sources: hits,
    appliedCorrections,
    expandedAliases,
    policyPlan,
    traceId,
  };
}

/**
 * Generate a grounded answer DIRECTLY from an already-retrieved candidate set
 * (e.g. the results of the Compare tab), WITHOUT re-running vector / lexical /
 * rerank retrieval.
 *
 * This is the "generate from these results" path: the caller supplies the
 * chunk identities it retrieved (docId + chunkIndex) plus the mode that
 * produced them. We:
 *   1. re-hydrate those exact chunks from Mongo, preserving the caller's order,
 *   2. re-resolve ONLY the cheap deterministic grounding (approved policy plan +
 *      legacy corrections — pure metadata lookups, no embeddings/search), so the
 *      answer keeps the same authoritative grounding a full RAG call would use,
 *   3. call the LLM (or extractive fallback).
 *
 * Retrieval is intentionally NOT repeated — the whole point is to reuse the
 * candidates the user is already looking at.
 */
export async function generateFromHits(
  query: string,
  selection: { docId: string; chunkIndex: number }[],
  fromMode: RetrievalMode,
  opts: {
    policyContext?: import("./policy-resolver").QueryContext;
  } = {}
): Promise<RagResult> {
  // 1. Re-hydrate the selected chunks (preserve caller-supplied order).
  const col = await getCollection();
  const ids = selection.map((s) => `${s.docId}#${s.chunkIndex}`);
  const docs = ids.length
    ? await col.find({ _id: { $in: ids } as any }).toArray()
    : [];
  const byId = new Map(docs.map((d: any) => [d._id, d]));
  const hits: SearchHit[] = selection
    .map((s, i) => {
      const d: any = byId.get(`${s.docId}#${s.chunkIndex}`);
      if (!d) return null;
      return {
        docId: d.docId,
        chunkIndex: d.chunkIndex ?? 0,
        title: d.title,
        docType: d.docType,
        propertyName: d.propertyName,
        propertyAliases: d.propertyAliases ?? [],
        segment: d.segment,
        language: d.language ?? [],
        audience: d.audience,
        tags: d.tags ?? [],
        exactTerms: d.exactTerms ?? [],
        extractedFields: d.extractedFields,
        chunkText: d.chunkText,
        updatedAt: d.updatedAt,
        documentId: d.documentId,
        sourceFileType: d.sourceFileType,
        versionLabel: d.versionLabel,
        versionGroupId: d.versionGroupId,
        obsoleteFlag: d.obsoleteFlag,
        effectiveFrom: d.effectiveFrom,
        ocrUsed: d.ocrUsed,
        score: 0,
        rank: i + 1,
      } as SearchHit;
    })
    .filter((h): h is SearchHit => h !== null);

  // 2. Re-resolve cheap deterministic grounding (no retrieval).
  let policyPlan: ResolvedPolicyPlan | null = null;
  try {
    policyPlan = await resolvePolicies(query, opts.policyContext ?? {});
  } catch {
    policyPlan = null;
  }
  let appliedCorrections: AppliedCorrections | null = null;
  try {
    appliedCorrections = await correctionsForQuery(query);
  } catch {
    appliedCorrections = null;
  }

  // 3. Generate.
  let answer: string;
  let llmUsed = false;
  if (!hits.length) {
    answer = "No candidate records were provided to ground an answer.";
  } else if (hasLLM()) {
    try {
      answer = await llmAnswer(query, hits, appliedCorrections, policyPlan);
      llmUsed = true;
    } catch (e) {
      answer =
        extractiveAnswer(query, hits) +
        `\n\n(Note: LLM call failed: ${(e as Error).message})`;
    }
  } else {
    answer = extractiveAnswer(query, hits);
  }

  return {
    answer,
    mode: fromMode,
    llmUsed,
    sources: hits,
    appliedCorrections,
    policyPlan,
  };
}

// ---------------------------------------------------------------------------
// Conversational RAG (multi-turn, with MongoDB-backed memory).
// ---------------------------------------------------------------------------

export interface ChatResult extends RagResult {
  conversationId: string;
  /** Older turns recalled from memory (semantic + keyword) for this question. */
  recalled: RecalledMessage[];
}

function buildRecalledContext(recalled: RecalledMessage[]): string {
  if (!recalled.length) return "";
  return recalled
    .map(
      (m) =>
        `- (${m.role}, ${new Date(m.createdAt).toLocaleString()}) ${m.messageText}`
    )
    .join("\n");
}

/**
 * Answer a turn inside a conversation. Retrieves corpus context (RAG) AND:
 *   - loads the recent turns of this thread (verbatim chat window), and
 *   - recalls relevant older turns from the whole memory store (semantic +
 *     keyword) to resolve back-references,
 * then generates a grounded answer and persists both the user turn and the
 * assistant turn (each embedded) back into memory.
 */
export async function chatRag(
  conversationId: string,
  query: string,
  limit = 6,
  opts: {
    includeObsolete?: boolean;
    recallFromAllConversations?: boolean;
    policyContext?: import("./policy-resolver").QueryContext;
  } = {}
): Promise<ChatResult> {
  // 1. Persist the user's turn first (so it's part of memory + embedded).
  await appendMessage(conversationId, "user", query);

  // 2. Gather conversation context: recent window + recalled older turns.
  const recentDocs = await getRecentMessages(conversationId, 8);
  // Drop the just-added current user turn from the history window (it's the
  // question we send last).
  const history = recentDocs
    .filter((m) => m.messageText !== query || m.role !== "user")
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.messageText }));

  let recalled: RecalledMessage[] = [];
  try {
    recalled = await recallMemory(query, 5, {
      conversationId: opts.recallFromAllConversations
        ? undefined
        : conversationId,
    });
    // Don't recall the exact current question back to itself.
    recalled = recalled.filter((m) => m.messageText !== query);
  } catch {
    recalled = [];
  }

  // 3. Corpus retrieval (same version/policy/correction-aware path as runRag).
  let mode: RetrievalMode;
  let hits: SearchHit[];
  let appliedCorrections: AppliedCorrections | null = null;
  let expandedAliases: string[] = [];
  let policyPlan: ResolvedPolicyPlan | null = null;
  let traceId: string | null = null;
  try {
    const r = await runSearchEnhanced("rerank", query, limit, {
      includeObsolete: opts.includeObsolete,
      policyContext: opts.policyContext,
    });
    hits = r.hits;
    appliedCorrections = r.appliedCorrections;
    expandedAliases = r.expandedAliases;
    policyPlan = r.policyPlan;
    traceId = r.traceId;
    mode = "rerank";
  } catch {
    const r = await runSearchEnhanced("hybrid", query, limit, {
      includeObsolete: opts.includeObsolete,
      policyContext: opts.policyContext,
    });
    hits = r.hits;
    appliedCorrections = r.appliedCorrections;
    expandedAliases = r.expandedAliases;
    policyPlan = r.policyPlan;
    traceId = r.traceId;
    mode = "hybrid";
  }

  // 4. Generate with dialogue history + recalled memory.
  let answer: string;
  let llmUsed = false;
  if (hasLLM()) {
    try {
      answer = await llmAnswer(query, hits, appliedCorrections, policyPlan, {
        history,
        recalledContext: buildRecalledContext(recalled),
      });
      llmUsed = true;
    } catch (e) {
      answer =
        extractiveAnswer(query, hits) +
        `\n\n(Note: LLM call failed: ${(e as Error).message})`;
    }
  } else {
    answer = extractiveAnswer(query, hits);
  }

  // 5. Persist the assistant turn (embedded, with its grounding docIds).
  await appendMessage(conversationId, "assistant", answer, {
    sourceDocIds: hits.map((h) => h.docId),
  });

  return {
    answer,
    mode,
    llmUsed,
    sources: hits,
    appliedCorrections,
    expandedAliases,
    policyPlan,
    traceId,
    conversationId,
    recalled,
  };
}
