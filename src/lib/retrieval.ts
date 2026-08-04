import type { Document } from "mongodb";
import { getCollection, ChunkDoc } from "./mongo";
import {
  env,
  hasVoyage,
  hasReranker,
  isAtlasEmbedding,
  hasMultimodalEmbed,
} from "./env";
import {
  voyageEmbedOne,
  voyageRerank,
  voyageEmbedMultimodalOne,
} from "./voyage";

export type RetrievalMode =
  | "vector"
  | "hybrid"
  | "rerank"
  // Model-comparison pseudo-modes: both are plain vector search, differing only
  // by which embedding model/index they target (voyage-4 vs voyage-multimodal-3.5).
  | "vector-primary"
  | "vector-multimodal";

/**
 * Which embedding model powers a vector search.
 *   - "primary"    : the default configured strategy (Atlas auto-embed voyage-4
 *                    when EMBEDDING_STRATEGY=atlas, else explicit Voyage).
 *   - "multimodal" : the secondary voyage-multimodal-3.5 explicit-vector index.
 */
export type EmbeddingModel = "primary" | "multimodal";

export interface SearchHit {
  docId: string;
  chunkIndex: number;
  title: string;
  docType: string;
  propertyName: string;
  propertyAliases: string[];
  segment: string;
  language: string[];
  audience?: string[];
  tags: string[];
  exactTerms: string[];
  extractedFields?: Record<string, string>;
  chunkText: string;
  updatedAt?: string;
  // ----- version / lifecycle / source (iteration 2) -----
  documentId?: string;
  sourceFileType?: string;
  sourceFileName?: string;
  /** For scanned-PDF page-image chunks: the 0-based page index. */
  pageImageIndex?: number;
  versionLabel?: string;
  versionGroupId?: string;
  obsoleteFlag?: boolean;
  effectiveFrom?: string;
  ocrUsed?: boolean;
  // scoring
  score: number; // primary score for the mode (normalised-ish)
  rank: number;
  vectorScore?: number;
  lexicalScore?: number;
  rerankScore?: number;
  matchedTerms?: string[];
  /** Why this hit was (re)ordered by human corrections, if any. */
  correctionNote?: string;
  /** Why this hit was (re)ordered by an approved KnowledgePolicy, if any. */
  policyNote?: string;
  // ----- FSI EXPANSION: structured address fields (surfaced for ranking/UI) -----
  metadataType?: string;
  floor_num?: number;
  unit_code?: string;
  block?: string;
  building_name?: string;
  district?: string;
  estate?: string;
  raw_address?: string;
  /** FSI EXPANSION: chunk _id, surfaced so the lab can fetch the raw document. */
  _id?: string;
}

const PROJECT = {
  _id: 1,
  docId: 1,
  chunkIndex: 1,
  title: 1,
  docType: 1,
  propertyName: 1,
  propertyAliases: 1,
  segment: 1,
  language: 1,
  audience: 1,
  tags: 1,
  exactTerms: 1,
  extractedFields: 1,
  chunkText: 1,
  updatedAt: 1,
  documentId: 1,
  sourceFileType: 1,
  sourceFileName: 1,
  pageImageIndex: 1,
  versionLabel: 1,
  versionGroupId: 1,
  obsoleteFlag: 1,
  effectiveFrom: 1,
  ocrUsed: 1,
  // FSI EXPANSION: structured address fields.
  metadataType: 1,
  floor_num: 1,
  unit_code: 1,
  block: 1,
  building_name: 1,
  district: 1,
  estate: 1,
  raw_address: 1,
} as const;

function toHit(doc: any, rank: number): SearchHit {
  return {
    docId: doc.docId,
    chunkIndex: doc.chunkIndex ?? 0,
    title: doc.title,
    docType: doc.docType,
    propertyName: doc.propertyName,
    propertyAliases: doc.propertyAliases ?? [],
    segment: doc.segment,
    language: doc.language ?? [],
    audience: doc.audience,
    tags: doc.tags ?? [],
    exactTerms: doc.exactTerms ?? [],
    extractedFields: doc.extractedFields,
    chunkText: doc.chunkText,
    updatedAt: doc.updatedAt,
    documentId: doc.documentId,
    sourceFileType: doc.sourceFileType,
    sourceFileName: doc.sourceFileName,
    pageImageIndex: doc.pageImageIndex,
    versionLabel: doc.versionLabel,
    versionGroupId: doc.versionGroupId,
    obsoleteFlag: doc.obsoleteFlag,
    effectiveFrom: doc.effectiveFrom,
    ocrUsed: doc.ocrUsed,
    // FSI EXPANSION: carry structured fields through for floor-aware ranking + UI.
    metadataType: doc.metadataType,
    floor_num: doc.floor_num,
    unit_code: doc.unit_code,
    block: doc.block,
    building_name: doc.building_name,
    district: doc.district,
    estate: doc.estate,
    raw_address: doc.raw_address,
    _id: doc._id != null ? String(doc._id) : undefined,
    score: 0,
    rank,
  };
}

// ---------------------------------------------------------------------------
// Shared sub-pipeline builders (used by $rankFusion and the explain module)
// ---------------------------------------------------------------------------

/** Build the $vectorSearch stage object for the given embedding model. */
export async function buildVectorSearchStage(
  query: string,
  limit: number,
  numCandidates = 150,
  model: EmbeddingModel = "primary"
): Promise<Record<string, unknown>> {
  if (model === "multimodal") {
    // voyage-multimodal-3.5 explicit-vector index; embed the query client-side.
    return {
      index: env.vectorIndexMultimodal,
      path: "embeddingMultimodal",
      queryVector: await voyageEmbedMultimodalOne(query, "query"),
      numCandidates,
      limit,
    };
  }
  const stage: Record<string, unknown> = {
    index: env.vectorIndex,
    numCandidates,
    limit,
  };
  if (isAtlasEmbedding()) {
    stage.path = "chunkText";
    stage.query = query;
  } else {
    stage.path = "embedding";
    stage.queryVector = await voyageEmbedOne(query, "query");
  }
  return stage;
}

/** Build the $search (Atlas Search / BM25) stage with exact-term boosting. */
export function buildLexicalSearchStage(query: string): Record<string, unknown> {
  return {
    index: env.searchIndex,
    compound: {
      should: [
        {
          text: {
            query,
            path: ["chunkText", "title", "sourceText"],
            fuzzy: { maxEdits: 1 },
          },
        },
        {
          text: {
            query,
            path: ["exactTerms", "propertyAliases", "propertyName"],
            score: { boost: { value: 5 } },
          },
        },
      ],
      minimumShouldMatch: 1,
    },
  };
}

/** Identify which of a doc's exact terms literally appear in the query. */
export function matchedTermsFor(query: string, hit: SearchHit): string[] {
  const q = query.toLowerCase();
  const terms = new Set<string>();
  for (const t of [...hit.exactTerms, ...hit.propertyAliases, hit.propertyName]) {
    if (!t) continue;
    if (q.includes(t.toLowerCase())) terms.add(t);
  }
  return [...terms];
}

// ---------------------------------------------------------------------------
// 1. VECTOR ONLY
// ---------------------------------------------------------------------------
export async function vectorSearch(
  query: string,
  limit = 8,
  filter?: Record<string, unknown>,
  model: EmbeddingModel = "primary"
): Promise<SearchHit[]> {
  const col = await getCollection();

  const vectorStage = await buildVectorSearchStage(query, limit, 150, model);

  if (filter && Object.keys(filter).length) vectorStage.filter = filter;

  const pipeline = [
    { $vectorSearch: vectorStage },
    {
      $project: { ...PROJECT, vectorScore: { $meta: "vectorSearchScore" } },
    },
  ];

  const docs = await col.aggregate(pipeline).toArray();
  return docs.map((d, i) => {
    const hit = toHit(d, i + 1);
    hit.vectorScore = d.vectorScore;
    hit.score = d.vectorScore ?? 0;
    hit.matchedTerms = matchedTermsFor(query, hit);
    return hit;
  });
}

// ---------------------------------------------------------------------------
// 2. HYBRID (Reciprocal Rank Fusion of Atlas Search + Vector Search)
// ---------------------------------------------------------------------------
async function lexicalSearch(
  query: string,
  limit = 50,
  filter?: Record<string, unknown>
): Promise<{ doc: any; lexicalScore: number; rank: number }[]> {
  const col = await getCollection();
  const pipeline: Document[] = [{ $search: buildLexicalSearchStage(query) }];
  if (filter && Object.keys(filter).length) pipeline.push({ $match: filter });
  pipeline.push(
    { $limit: limit },
    { $project: { ...PROJECT, lexicalScore: { $meta: "searchScore" } } }
  );
  const docs = await col.aggregate(pipeline).toArray();
  return docs.map((doc, i) => ({
    doc,
    lexicalScore: doc.lexicalScore ?? 0,
    rank: i + 1,
  }));
}

export interface HybridOptions {
  vectorWeight?: number; // 0..1
  lexicalWeight?: number; // 0..1
  rrfK?: number;
  poolSize?: number;
  /** $vectorSearch filter (e.g. exclude obsolete chunks). */
  filter?: Record<string, unknown>;
}

/**
 * Build the single, unified $rankFusion hybrid-search pipeline. This is one
 * MongoDB aggregation that runs the vector and lexical sub-pipelines and fuses
 * them server-side with Reciprocal Rank Fusion - no application-side merging.
 */
export async function buildRankFusionPipeline(
  query: string,
  limit: number,
  opts: HybridOptions = {}
): Promise<unknown[]> {
  const vectorWeight = opts.vectorWeight ?? 0.5;
  const lexicalWeight = opts.lexicalWeight ?? 0.5;
  const pool = opts.poolSize ?? 50;

  const vectorStage = await buildVectorSearchStage(query, pool, 150);
  if (opts.filter && Object.keys(opts.filter).length) {
    vectorStage.filter = opts.filter;
  }

  // The $search arm can't take a $vectorSearch-style filter, so we add a
  // post-search $match inside the lexical sub-pipeline for the same effect
  // (e.g. excluding obsolete chunks).
  const lexicalSub: Record<string, unknown>[] = [
    { $search: buildLexicalSearchStage(query) },
  ];
  if (opts.filter && Object.keys(opts.filter).length) {
    lexicalSub.push({ $match: opts.filter });
  }
  lexicalSub.push({ $limit: pool });

  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vectorStage }],
            lexical: lexicalSub,
          },
        },
        combination: {
          weights: { vector: vectorWeight, lexical: lexicalWeight },
        },
        scoreDetails: true,
      },
    },
    { $limit: limit },
    {
      $project: {
        ...PROJECT,
        score: { $meta: "score" },
        scoreDetails: { $meta: "scoreDetails" },
      },
    },
  ];
}

export async function hybridSearch(
  query: string,
  limit = 8,
  opts: HybridOptions = {}
): Promise<SearchHit[]> {
  const col = await getCollection();
  const pipeline = await buildRankFusionPipeline(query, limit, opts);
  const docs = await col.aggregate(pipeline as Document[]).toArray();

  return docs.map((d, i) => {
    const hit = toHit(d, i + 1);
    hit.score = d.score ?? 0;

    // Pull per-arm rank/value out of $rankFusion scoreDetails so the UI can
    // still show which arm contributed (vector vs lexical).
    const details: any[] = d.scoreDetails?.details ?? [];
    for (const arm of details) {
      if (arm.inputPipelineName === "vector") hit.vectorScore = arm.value;
      if (arm.inputPipelineName === "lexical") hit.lexicalScore = arm.value;
    }

    hit.matchedTerms = matchedTermsFor(query, hit);
    return hit;
  });
}

// ---------------------------------------------------------------------------
// FSI EXPANSION — Hybrid + floor/unit tiering, ALL IN ONE AGGREGATION PIPELINE.
//
// Design (customer-requested): do NOT re-rank in application code. In a single
// aggregation: run hybrid ($rankFusion of vector + lexical) so the building is
// understood by search; capture the RRF score into a real field; then compute a
// structured tier from floor_num/unit_code and $sort by { tier, hybridScore }.
// The building is NEVER matched by regex/name — floor/unit only re-order the
// hybrid candidates. Works for any language / entity. MongoDB 8.0+.
// ---------------------------------------------------------------------------
export interface FloorTierOpts extends HybridOptions {
  /** Parsed target floor. */
  floor?: number;
  /** Parsed target unit; matched tolerantly against padded/raw variants. */
  unit?: string;
}

/** Padded/raw unit-code variants so "0803" and "803" are equivalent. */
export function unitCodeVariants(unit: string): string[] {
  const set = new Set<string>([unit]);
  if (/^0\d{3}$/.test(unit)) set.add(unit.replace(/^0+(?=\d)/, ""));
  if (/^\d{3}$/.test(unit)) set.add("0" + unit);
  return [...set];
}

export async function buildFloorTierPipeline(
  query: string,
  limit: number,
  opts: FloorTierOpts = {}
): Promise<unknown[]> {
  // Step 1: the standard hybrid pipeline (vector + lexical), minus its trailing
  // $project — we keep the docs whole so we can tier + sort them below.
  const hybrid = await buildRankFusionPipeline(query, opts.poolSize ?? 50, {
    ...opts,
    poolSize: opts.poolSize ?? 50,
  });
  // buildRankFusionPipeline returns [ $rankFusion, $limit, $project ]. Drop the
  // final $project so we can add fields; keep $rankFusion (+ its inner $limit).
  const rankFusionStage = hybrid[0];

  const pipeline: unknown[] = [rankFusionStage];

  // Step 2: capture the hybrid RRF score as a real field (so we can sort by it
  // AFTER re-tiering). $meta:"score" is only readable right after $rankFusion.
  pipeline.push({ $addFields: { _hybridScore: { $meta: "score" } } });

  // Step 3: compute a structured tier IN-PIPELINE (no app-side JS).
  //   tier 0: exact floor AND exact unit   (the queried room)
  //   tier 1: exact floor                  (same-floor neighbours)
  //   tier 2: everything else
  if (opts.floor != null) {
    const branches: Record<string, unknown>[] = [];
    if (opts.unit) {
      branches.push({
        case: {
          $and: [
            { $eq: ["$floor_num", opts.floor] },
            { $in: ["$unit_code", unitCodeVariants(opts.unit)] },
          ],
        },
        then: 0,
      });
    }
    branches.push({ case: { $eq: ["$floor_num", opts.floor] }, then: 1 });
    pipeline.push({
      $addFields: { _tier: { $switch: { branches, default: 2 } } },
    });
    // Step 4: structured ordering — same-floor/unit first, hybrid score within.
    pipeline.push({ $sort: { _tier: 1, _hybridScore: -1 } });
  } else {
    // No parsed floor: keep pure hybrid order.
    pipeline.push({ $sort: { _hybridScore: -1 } });
  }

  pipeline.push({ $limit: limit });
  pipeline.push({
    $project: { ...PROJECT, score: "$_hybridScore", _tier: 1 },
  });
  return pipeline;
}

export async function floorTierSearch(
  query: string,
  limit = 8,
  opts: FloorTierOpts = {}
): Promise<SearchHit[]> {
  const col = await getCollection();
  const pipeline = await buildFloorTierPipeline(query, limit, opts);
  const docs = await col.aggregate(pipeline as Document[]).toArray();
  return docs.map((d, i) => {
    const hit = toHit(d, i + 1);
    hit.score = d.score ?? 0;
    hit.matchedTerms = matchedTermsFor(query, hit);
    return hit;
  });
}

// ---------------------------------------------------------------------------
// 3. VECTOR + RERANKER
// ---------------------------------------------------------------------------
export async function vectorRerankSearch(
  query: string,
  limit = 8,
  candidatePool = 25,
  filter?: Record<string, unknown>
): Promise<SearchHit[]> {
  // Pull a wider candidate set with vector (and lexical) then rerank.
  const [vec, lex] = await Promise.all([
    vectorSearch(query, candidatePool, filter),
    hasVoyage()
      ? lexicalSearch(query, candidatePool, filter)
      : Promise.resolve([]),
  ]);

  // De-dupe candidate pool from both sources.
  const poolMap = new Map<string, SearchHit>();
  vec.forEach((h) => poolMap.set(`${h.docId}#${h.chunkIndex}`, h));
  lex.forEach((l) => {
    const h = toHit(l.doc, 0);
    const key = `${h.docId}#${h.chunkIndex}`;
    if (!poolMap.has(key)) {
      h.lexicalScore = l.lexicalScore;
      poolMap.set(key, h);
    } else {
      poolMap.get(key)!.lexicalScore = l.lexicalScore;
    }
  });

  const pool = [...poolMap.values()];
  if (!pool.length) return [];

  if (!hasReranker()) {
    // Degraded mode: just return vector ordering.
    return pool.slice(0, limit).map((h, i) => {
      h.rank = i + 1;
      h.matchedTerms = matchedTermsFor(query, h);
      return h;
    });
  }

  const reranked = await voyageRerank(
    query,
    pool.map((h) => h.chunkText),
    limit
  );

  return reranked.map((r, i) => {
    const hit = pool[r.index];
    hit.rank = i + 1;
    hit.rerankScore = r.relevanceScore;
    hit.score = r.relevanceScore;
    hit.matchedTerms = matchedTermsFor(query, hit);
    return hit;
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export async function runSearch(
  mode: RetrievalMode,
  query: string,
  limit = 8,
  opts: HybridOptions = {}
): Promise<SearchHit[]> {
  switch (mode) {
    case "vector":
      return vectorSearch(query, limit, opts.filter);
    case "hybrid":
      return hybridSearch(query, limit, opts);
    case "rerank":
      return vectorRerankSearch(query, limit, 25, opts.filter);
    case "vector-primary":
      return vectorSearch(query, limit, opts.filter, "primary");
    case "vector-multimodal":
      return vectorSearch(query, limit, opts.filter, "multimodal");
  }
}

// ---------------------------------------------------------------------------
// Enhanced dispatcher: version-aware filtering + human-correction overrides.
// This is the entry point the API uses; runSearch stays as the raw primitive.
// ---------------------------------------------------------------------------
import { obsoleteFilter } from "./versioning";
import {
  correctionsForQuery,
  applyCorrectionOrdering,
  AppliedCorrections,
} from "./corrections";
import { aliasesForQuery } from "./aliases";
import {
  resolvePolicies,
  buildExpandedQuery,
  ResolvedPolicyPlan,
  QueryContext,
} from "./policy-resolver";
import { recordTrace } from "./policy-trace";

export interface EnhancedSearchOptions extends HybridOptions {
  /** Include obsolete / superseded versions (default false = prefer newest). */
  includeObsolete?: boolean;
  /** Apply stored human corrections (pin/demote/term meaning). Default true. */
  applyCorrections?: boolean;
  /** Expand the query with known property aliases for the lexical arm. */
  expandAliases?: boolean;
  /**
   * Apply the governed Knowledge Policy Layer (approved KnowledgePolicy records)
   * deterministically. Default true. When true this supersedes the legacy
   * user_corrections overlay for anything the policy layer covers; the legacy
   * overlay still runs for backward compatibility.
   */
  applyPolicies?: boolean;
  /** Query-understanding context used for deterministic policy scoping. */
  policyContext?: QueryContext;
  /** Persist a PolicyApplicationTrace for this query. Default true. */
  recordTrace?: boolean;
  /**
   * FSI EXPANSION: dataset isolation. When set (e.g. "property" | "fsi"), all
   * search arms are filtered to that dataset via the `metadataType` field.
   * Property docs seeded before this feature have no metadataType; a "property"
   * request therefore also matches missing values (see filter build below).
   */
  metadataType?: "property" | "fsi";
}

export interface EnhancedSearchResult {
  hits: SearchHit[];
  appliedCorrections: AppliedCorrections | null;
  expandedAliases: string[];
  matchedProperties: string[];
  includeObsolete: boolean;
  /** The deterministic policy plan applied to this query (Knowledge Policy Layer). */
  policyPlan: ResolvedPolicyPlan | null;
  /** Id of the PolicyApplicationTrace persisted for this query, if any. */
  traceId: string | null;
}

export async function runSearchEnhanced(
  mode: RetrievalMode,
  query: string,
  limit = 8,
  opts: EnhancedSearchOptions = {}
): Promise<EnhancedSearchResult> {
  const includeObsolete = opts.includeObsolete ?? false;
  const applyCorr = opts.applyCorrections ?? true;
  const expand = opts.expandAliases ?? true;
  const applyPol = opts.applyPolicies ?? true;
  const doTrace = opts.recordTrace ?? true;

  // Version-aware filter (prefer newest by excluding obsolete by default).
  let filter = obsoleteFilter(includeObsolete);

  // FSI EXPANSION: physically isolate the two datasets by metadataType. For
  // "property" we also accept docs where the field is absent (legacy seed data).
  if (opts.metadataType) {
    // Atlas $vectorSearch filters reject null in $in; use $ne so "property"
    // also matches legacy docs that predate the metadataType field.
    const dsFilter =
      opts.metadataType === "property"
        ? { metadataType: { $ne: "fsi" } }
        : { metadataType: "fsi" };
    filter = filter ? { ...filter, ...dsFilter } : dsFilter;
  }

  // ----- Knowledge Policy Layer (deterministic, authoritative) -----
  // Resolve approved policies on the ORIGINAL query first so their query
  // expansion and canonical meanings are available before alias expansion.
  let policyPlan: ResolvedPolicyPlan | null = null;
  if (applyPol) {
    try {
      policyPlan = await resolvePolicies(query, opts.policyContext ?? {});
    } catch {
      policyPlan = null; // collection may not exist yet — degrade gracefully
    }
  }

  // Alias expansion enriches the query string for the lexical/vector arms.
  let effectiveQuery = query;
  let expandedAliases: string[] = [];
  let matchedProperties: string[] = [];
  if (expand) {
    try {
      const a = await aliasesForQuery(query);
      expandedAliases = a.expandedAliases;
      matchedProperties = a.matchedProperties;
      if (expandedAliases.length) {
        effectiveQuery = `${query} ${expandedAliases.join(" ")}`;
      }
    } catch {
      /* alias collection may not exist yet — degrade gracefully */
    }
  }

  // Layer policy-driven query expansion on top (deterministic, from approved
  // policies — e.g. 關水喉 -> "isolate water supply", "shut water supply valve").
  if (policyPlan) {
    effectiveQuery = buildExpandedQuery(effectiveQuery, policyPlan);
  }

  // Corrections that apply to this query (computed on the ORIGINAL query).
  // Legacy overlay kept for backward compatibility with user_corrections.
  let applied: AppliedCorrections | null = null;
  if (applyCorr) {
    try {
      applied = await correctionsForQuery(query);
    } catch {
      applied = null;
    }
  }

  // Fetch a slightly wider set so pin/demote reordering has material to work
  // with, then trim back to limit after corrections. When excluding obsolete we
  // also over-fetch so post-filtering still leaves enough results. Policy
  // boost/demote/exclude reordering also benefits from a wider pool.
  const policyReorders =
    !!policyPlan &&
    (policyPlan.boostDocumentIds.length ||
      policyPlan.demoteDocumentIds.length ||
      policyPlan.excludeDocumentIds.length ||
      policyPlan.preferDocumentIds.length);
  const fetchLimit =
    ((applied &&
      (applied.pinnedDocIds.length || applied.demotedDocIds.length)) ||
    policyReorders
      ? Math.max(limit + 4, limit)
      : limit) + (!includeObsolete ? 6 : 0);

  let usedServerFilter = !!filter;
  let hits: SearchHit[];
  try {
    hits = await runSearch(mode, effectiveQuery, fetchLimit, {
      ...opts,
      filter,
    });
  } catch (e) {
    // The Atlas index may not yet have the lifecycle fields registered as
    // filters (e.g. before `npm run reindex`). Degrade gracefully: retry with
    // no server-side filter and apply the obsolete filter in-app instead.
    const msg = (e as Error).message ?? "";
    if (/needs to be indexed as filter|Path .* filter/i.test(msg)) {
      usedServerFilter = false;
      hits = await runSearch(mode, effectiveQuery, fetchLimit, {
        ...opts,
        filter: undefined,
      });
    } else {
      throw e;
    }
  }

  // In-app obsolete filtering (used when the server filter wasn't applied).
  if (!includeObsolete && !usedServerFilter) {
    hits = hits.filter((h) => h.obsoleteFlag !== true);
  }

  // ----- Deterministic Knowledge Policy application on results -----
  // Order matters: policy layer (authoritative) first, then legacy overlay.
  if (policyPlan) {
    hits = applyPolicyPlanToHits(hits, policyPlan);
  }

  if (applied) {
    hits = applyCorrectionOrdering(hits, applied);
    const pinned = new Set(applied.pinnedDocIds);
    const demoted = new Set(applied.demotedDocIds);
    hits.forEach((h) => {
      if (pinned.has(h.docId)) h.correctionNote = "pinned by reviewer";
      else if (demoted.has(h.docId)) h.correctionNote = "demoted by reviewer";
    });
  }

  hits = hits.slice(0, limit).map((h, i) => ({ ...h, rank: i + 1 }));

  // Record a deterministic audit trace of what the policy layer did.
  let traceId: string | null = null;
  if (doTrace && policyPlan && policyPlan.appliedPolicies.length) {
    try {
      const trace = await recordTrace({
        tenantId: opts.policyContext?.tenantId,
        conversationId: opts.policyContext ? undefined : null,
        queryText: query,
        expandedQuery: effectiveQuery !== query ? effectiveQuery : null,
        plan: policyPlan,
      });
      traceId = trace.id;
    } catch {
      /* tracing must never break retrieval */
    }
  }

  return {
    hits,
    appliedCorrections: applied,
    expandedAliases,
    matchedProperties,
    includeObsolete,
    policyPlan,
    traceId,
  };
}

/**
 * Apply a resolved policy plan to a ranked hit list, deterministically:
 *   - drop excluded docIds,
 *   - move boosted/preferred docIds to the front, demoted to the back,
 *   - apply rerank deltas as a stable secondary sort within each bucket,
 *   - annotate each hit with a human-readable policyNote for the UI.
 */
export function applyPolicyPlanToHits(
  hits: SearchHit[],
  plan: ResolvedPolicyPlan
): SearchHit[] {
  const boost = new Set(plan.boostDocumentIds);
  const demote = new Set(plan.demoteDocumentIds);
  const exclude = new Set(plan.excludeDocumentIds);
  const prefer = new Set(plan.preferDocumentIds);

  const kept = hits.filter((h) => {
    if (exclude.has(h.docId)) {
      return false;
    }
    return true;
  });

  const head: SearchHit[] = [];
  const mid: SearchHit[] = [];
  const tail: SearchHit[] = [];
  for (const h of kept) {
    const delta = plan.rerankDeltas[h.docId];
    if (typeof delta === "number") h.score = (h.score ?? 0) + delta;
    if (prefer.has(h.docId) || boost.has(h.docId)) {
      h.policyNote = "boosted by policy";
      head.push(h);
    } else if (demote.has(h.docId)) {
      h.policyNote = "demoted by policy";
      tail.push(h);
    } else {
      mid.push(h);
    }
  }
  // Stable sort each bucket by (adjusted) score desc so rerank deltas take
  // effect without reshuffling ties.
  const byScore = (a: SearchHit, b: SearchHit) => (b.score ?? 0) - (a.score ?? 0);
  head.sort(byScore);
  tail.sort(byScore);
  return [...head, ...mid, ...tail];
}
