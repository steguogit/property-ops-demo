// =============================================================================
// Knowledge retrieval — real MongoDB Atlas Search (keyword) and Vector Search
// (semantic, via Atlas automatic embedding over `chunkText`) against the
// bops_knowledge collection.
//
// Keyword mode  -> $search (lexical_index), with equipment/doc-type filters,
//                  highlights, and score.
// Semantic mode -> $vectorSearch (autoEmbed vector index) over the written
//                  symptom prose. Atlas embeds both the stored chunkText and
//                  the query string at search time (voyage-4). This is semantic
//                  retrieval of WRITTEN SYMPTOMS, not waveform similarity.
// =============================================================================
import { knowledgeCol } from "./mongo";
import { BOPS_INDEXES, AssetType } from "./config";
import type { KnowledgeDoc, KnowledgeDocType } from "./mongo";

export interface KnowledgeHit {
  docId: string;
  docType: KnowledgeDocType;
  title: string;
  equipmentType: string;
  model?: string;
  source: string;
  revision: string;
  docDate: string;
  excerpt: string;
  /** Lexical: $search score. Semantic: vectorSearchScore (retrieval
   *  similarity, NOT a diagnosis probability). */
  score: number;
  /** Plain-text highlight fragments (keyword mode) — never raw HTML. */
  highlights?: string[];
  history?: KnowledgeDoc["history"];
  procedure?: KnowledgeDoc["procedure"];
}

export interface KnowledgeFilters {
  equipmentType?: AssetType | "general";
  docType?: KnowledgeDocType;
}

function filterClause(f: KnowledgeFilters): Record<string, unknown> {
  const clause: Record<string, unknown> = {};
  if (f.equipmentType) clause.equipmentType = f.equipmentType;
  if (f.docType) clause.docType = f.docType;
  return clause;
}

export function buildKeywordPipeline(
  query: string,
  f: KnowledgeFilters,
  limit: number
): object[] {
  const filter = filterClause(f);
  const compound: any = {
    must: [{ text: { query, path: ["title", "chunkText"] } }],
  };
  // equipmentType / docType are indexed as `token` fields -> use `equals`.
  const filterTerms = Object.entries(filter).map(([k, v]) => ({
    equals: { value: String(v), path: k },
  }));
  if (filterTerms.length) compound.filter = filterTerms;
  return [
    {
      $search: {
        index: BOPS_INDEXES.knowledgeLexical,
        compound,
        highlight: { path: ["chunkText", "title"] },
      },
    },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        docId: 1,
        docType: 1,
        title: 1,
        equipmentType: 1,
        model: 1,
        source: 1,
        revision: 1,
        docDate: 1,
        chunkText: 1,
        history: 1,
        procedure: 1,
        score: { $meta: "searchScore" },
        highlights: { $meta: "searchHighlights" },
      },
    },
  ];
}

export function buildVectorPipeline(
  query: string,
  f: KnowledgeFilters,
  limit: number
): object[] {
  const filter = filterClause(f);
  const vs: any = {
    index: BOPS_INDEXES.knowledgeVector,
    path: "chunkText",
    query: { text: query }, // Atlas auto-embeds the query string (voyage-4)
    numCandidates: Math.max(50, limit * 10),
    limit,
  };
  if (Object.keys(filter).length) vs.filter = filter;
  return [
    { $vectorSearch: vs },
    {
      $project: {
        _id: 0,
        docId: 1,
        docType: 1,
        title: 1,
        equipmentType: 1,
        model: 1,
        source: 1,
        revision: 1,
        docDate: 1,
        chunkText: 1,
        history: 1,
        procedure: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];
}

function toHit(d: any): KnowledgeHit {
  const excerpt =
    typeof d.chunkText === "string"
      ? d.chunkText.slice(0, 280) + (d.chunkText.length > 280 ? "…" : "")
      : "";
  // Flatten Atlas searchHighlights into plain-text fragments (no HTML).
  const highlights: string[] | undefined = Array.isArray(d.highlights)
    ? d.highlights
        .map((h: any) =>
          Array.isArray(h.texts) ? h.texts.map((t: any) => t.value).join("") : ""
        )
        .filter(Boolean)
    : undefined;
  return {
    docId: d.docId,
    docType: d.docType,
    title: d.title,
    equipmentType: d.equipmentType,
    model: d.model,
    source: d.source,
    revision: d.revision,
    docDate: d.docDate,
    excerpt,
    score: typeof d.score === "number" ? d.score : 0,
    highlights,
    history: d.history,
    procedure: d.procedure,
  };
}

export async function keywordSearch(
  query: string,
  f: KnowledgeFilters,
  limit = 6
): Promise<{ hits: KnowledgeHit[]; ms: number; pipeline: object[] }> {
  const col = await knowledgeCol();
  const pipeline = buildKeywordPipeline(query, f, limit);
  const t0 = Date.now();
  const rows = await col.aggregate(pipeline).toArray();
  return { hits: rows.map(toHit), ms: Date.now() - t0, pipeline };
}

export interface FacetBucket {
  value: string;
  count: number;
}

/**
 * Facet-based navigation for keyword mode. A real `$searchMeta` facet query
 * returns, for the current query text, the count of matching documents grouped
 * by equipmentType and docType — so the UI can offer clickable facet filters
 * with live counts (not hardcoded). Uses the `facet` collector over the
 * `stringFacet`-mapped fields.
 */
export function buildFacetPipeline(query: string): object[] {
  return [
    {
      $searchMeta: {
        index: BOPS_INDEXES.knowledgeLexical,
        facet: {
          operator: { text: { query, path: ["title", "chunkText"] } },
          facets: {
            equipmentType: { type: "string", path: "equipmentType" },
            docType: { type: "string", path: "docType" },
          },
        },
      },
    },
  ];
}

export async function keywordFacets(
  query: string
): Promise<{ equipmentType: FacetBucket[]; docType: FacetBucket[]; ms: number; pipeline: object[] }> {
  const col = await knowledgeCol();
  const pipeline = buildFacetPipeline(query);
  const t0 = Date.now();
  const rows = await col.aggregate(pipeline).toArray();
  const meta = (rows[0] as any)?.facet ?? {};
  const toNum = (c: any): number =>
    typeof c === "number" ? c : typeof c?.toNumber === "function" ? c.toNumber() : Number(c ?? 0);
  const map = (f: any): FacetBucket[] =>
    Array.isArray(f?.buckets)
      ? f.buckets.map((b: any) => ({ value: String(b._id), count: toNum(b.count) }))
      : [];
  return {
    equipmentType: map(meta.equipmentType),
    docType: map(meta.docType),
    ms: Date.now() - t0,
    pipeline,
  };
}

export async function semanticSearch(
  query: string,
  f: KnowledgeFilters,
  limit = 6
): Promise<{ hits: KnowledgeHit[]; ms: number; pipeline: object[] }> {
  const col = await knowledgeCol();
  const pipeline = buildVectorPipeline(query, f, limit);
  const t0 = Date.now();
  const rows = await col.aggregate(pipeline).toArray();
  return { hits: rows.map(toHit), ms: Date.now() - t0, pipeline };
}

/** Check whether the knowledge search indexes are built + queryable. Used to
 *  present Search / Vector Search as available (honest unavailable state). */
export async function searchReadiness(): Promise<{
  lexical: "ready" | "building" | "absent" | "error";
  vector: "ready" | "building" | "absent" | "error";
  detail?: string;
}> {
  try {
    const col = await knowledgeCol();
    const idx = await (col as any).listSearchIndexes().toArray();
    const byName = (n: string) => idx.find((i: any) => i.name === n);
    const stat = (i: any): "ready" | "building" | "absent" | "error" => {
      if (!i) return "absent";
      if (i.queryable || i.status === "READY") return "ready";
      if (i.status === "BUILDING" || i.status === "PENDING") return "building";
      return "error";
    };
    return {
      lexical: stat(byName(BOPS_INDEXES.knowledgeLexical)),
      vector: stat(byName(BOPS_INDEXES.knowledgeVector)),
    };
  } catch (e) {
    return { lexical: "error", vector: "error", detail: (e as Error).message };
  }
}
