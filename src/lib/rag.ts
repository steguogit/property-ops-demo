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

/**
 * Best-effort page reference for a retrieved chunk so answers can cite exact
 * pages. Sources, in priority order:
 *   1. `pageImageIndex` (scanned-PDF page-image chunks) → page N (1-based)
 *   2. `[Page N]` markers embedded in the OCR/extracted chunkText
 * Returns e.g. "p.3" / "pp.3-5", or undefined when unknown.
 */
function pageRefFor(h: SearchHit): string | undefined {
  if (typeof h.pageImageIndex === "number") {
    return `p.${h.pageImageIndex + 1}`;
  }
  const nums = new Set<number>();
  const re = /\[Page\s+(\d+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h.chunkText || "")) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) nums.add(n);
  }
  if (!nums.size) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted.length === 1
    ? `p.${sorted[0]}`
    : `pp.${sorted[0]}-${sorted[sorted.length - 1]}`;
}

function buildContext(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const page = pageRefFor(h);
      const src = h.sourceFileName ? `, file: ${h.sourceFileName}` : "";
      const loc = page ? `, ${page}` : "";
      return (
        `[#${i + 1}] (${h.docId}, ${h.docType}, property: ${h.propertyName}${src}${loc})\n` +
        `Title: ${h.title}\n${h.chunkText}`
      );
    })
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
    // ---- Output formatting & grounding rules ----
    "OUTPUT RULES: " +
    "1) CALCULATIONS: Whenever the answer involves any numbers, totals, sums, differences, percentages, rates, or reconciliations, present them as a Markdown TABLE with an explicit line-item breakdown (one row per component) plus a final Total row. " +
    "Only use figures that appear verbatim in the context; never invent or estimate numbers. In each row, cite the source in a column, e.g. [DOC-ID p.3]. If a needed figure is missing from the context, write 'not stated' rather than guessing. " +
    "2) SUMMARIES / FACTUAL ANSWERS: Ground every statement in the context. After each fact or bullet, cite the exact source AND page, e.g. [DOC-ID p.3] or [DOC-ID pp.3-5]. " +
    "Each context record is labelled with its docId and page (p.N) — use those exact page numbers; if a record has no page label, cite the docId only. " +
    "3) Do NOT state anything not supported by the context. If the answer is not in the context, say so explicitly. Do not hide uncertainty — if a figure or fact is partial or ambiguous, say so. " +
    "Handle English and Chinese property names/aliases correctly.";

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
    `Context records:\n${context}\n\n` +
    "Provide a grounded answer. Cite sources inline as [docId p.N] using the docId and page label shown for each record. " +
    "If the answer involves any numbers/totals, show a Markdown table with a per-line-item breakdown and a Total row (figures only from the context).";

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
    datasetId?: string;
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
      datasetId: opts.datasetId,
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
      datasetId: opts.datasetId,
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

/** One pipeline stage of a conversational turn (for the collapsible steps UI). */
export interface ChatStep {
  step: string;
  ms: number;
  note?: string;
}

export interface ChatResult extends RagResult {
  conversationId: string;
  /** Older turns recalled from memory (semantic + keyword) for this question. */
  recalled: RecalledMessage[];
  /** Ordered pipeline steps taken to produce this turn (for transparency). */
  steps: ChatStep[];
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
    datasetId?: string;
    policyContext?: import("./policy-resolver").QueryContext;
  } = {}
): Promise<ChatResult> {
  const steps: ChatStep[] = [];
  const stepTimer = (step: string) => {
    const t0 = Date.now();
    return (note?: string) =>
      steps.push({ step, ms: Date.now() - t0, note });
  };

  // 1. Persist the user's turn first (so it's part of memory + embedded).
  const endPersistUser = stepTimer("Store user turn in memory (embedded)");
  await appendMessage(conversationId, "user", query);
  endPersistUser();

  // 2. Gather conversation context: recent window + recalled older turns.
  const endHistory = stepTimer("Load recent conversation window");
  const recentDocs = await getRecentMessages(conversationId, 8);
  // Drop the just-added current user turn from the history window (it's the
  // question we send last).
  const history = recentDocs
    .filter((m) => m.messageText !== query || m.role !== "user")
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.messageText }));
  endHistory(`${history.length} recent turn(s)`);

  const endRecall = stepTimer(
    "Recall relevant past turns (semantic + keyword memory)"
  );
  let recalled: RecalledMessage[] = [];
  try {
    recalled = await recallMemory(query, 5, {
      conversationId: opts.recallFromAllConversations
        ? undefined
        : conversationId,
      // Dataset isolation: even "recall from all conversations" must stay within
      // the active demo, so one demo never leaks memory into another.
      datasetId: opts.datasetId,
    });
    // Don't recall the exact current question back to itself.
    recalled = recalled.filter((m) => m.messageText !== query);
  } catch {
    recalled = [];
  }
  endRecall(
    `${recalled.length} recalled${
      opts.recallFromAllConversations ? " (all conversations)" : ""
    }`
  );

  // 3. Corpus retrieval (same version/policy/correction-aware path as runRag).
  const endRetrieve = stepTimer("Retrieve grounding from document corpus");
  let mode: RetrievalMode;
  let hits: SearchHit[];
  let appliedCorrections: AppliedCorrections | null = null;
  let expandedAliases: string[] = [];
  let policyPlan: ResolvedPolicyPlan | null = null;
  let traceId: string | null = null;
  try {
    const r = await runSearchEnhanced("rerank", query, limit, {
      includeObsolete: opts.includeObsolete,
      datasetId: opts.datasetId,
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
      datasetId: opts.datasetId,
      policyContext: opts.policyContext,
    });
    hits = r.hits;
    appliedCorrections = r.appliedCorrections;
    expandedAliases = r.expandedAliases;
    policyPlan = r.policyPlan;
    traceId = r.traceId;
    mode = "hybrid";
  }
  endRetrieve(`${mode} · ${hits.length} source chunk(s)`);

  // 4. Generate with dialogue history + recalled memory.
  const endGen = stepTimer("Generate grounded answer (LLM)");
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
  endGen(llmUsed ? env.llmModel : "extractive (no LLM)");

  // 5. Persist the assistant turn (embedded, with its grounding docIds).
  const endPersistAssistant = stepTimer(
    "Store assistant turn in memory (embedded)"
  );
  await appendMessage(conversationId, "assistant", answer, {
    sourceDocIds: hits.map((h) => h.docId),
  });
  endPersistAssistant();

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
    steps,
  };
}
