import { env, isAtlasEmbedding } from "./env";
import type { RetrievalMode } from "./retrieval";

// Produces the *actual* MongoDB aggregation pipelines and the list of
// MongoDB/Atlas features each retrieval mode uses. This is the single source of
// truth surfaced in the "Show query" modal so what the user sees matches what
// the server executed.

const PROJECT_DISPLAY = {
  _id: 0,
  docId: 1,
  title: 1,
  docType: 1,
  propertyName: 1,
  chunkText: 1,
} as const;

export interface MongoFeature {
  name: string;
  detail: string;
}

export interface ExplainStage {
  label: string; // e.g. "Atlas Vector Search"
  collection: string;
  pipeline: unknown[]; // the real aggregation pipeline
}

export interface ModeExplain {
  mode: RetrievalMode | "rag";
  title: string;
  features: MongoFeature[];
  stages: ExplainStage[];
  notes?: string;
}

function vectorStage(query: string, limit: number, numCandidates = 150) {
  const stage: Record<string, unknown> = {
    index: env.vectorIndex,
    numCandidates,
    limit,
  };
  if (isAtlasEmbedding()) {
    stage.path = "chunkText";
    stage.query = query; // Atlas embeds the query server-side
  } else {
    stage.path = "embedding";
    stage.queryVector = ["<query embedding vector — 1024 dims>"];
  }
  return stage;
}

function vectorPipeline(query: string, limit: number, numCandidates = 150) {
  return [
    { $vectorSearch: vectorStage(query, limit, numCandidates) },
    {
      $project: {
        ...PROJECT_DISPLAY,
        vectorScore: { $meta: "vectorSearchScore" },
      },
    },
  ];
}

function multimodalVectorStage(query: string, limit: number, numCandidates = 150) {
  return {
    index: env.vectorIndexMultimodal,
    path: "embeddingMultimodal",
    queryVector: ["<voyage-multimodal-3.5 query embedding — 1024 dims>"],
    numCandidates,
    limit,
  };
}

function multimodalVectorPipeline(query: string, limit: number) {
  return [
    { $vectorSearch: multimodalVectorStage(query, limit) },
    {
      $project: {
        ...PROJECT_DISPLAY,
        vectorScore: { $meta: "vectorSearchScore" },
      },
    },
  ];
}

function lexicalSearchStage(query: string) {
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

function lexicalPipeline(query: string, limit: number) {
  return [
    { $search: lexicalSearchStage(query) },
    { $limit: limit },
    {
      $project: { ...PROJECT_DISPLAY, lexicalScore: { $meta: "searchScore" } },
    },
  ];
}

/** Single unified hybrid pipeline using the native $rankFusion stage. */
function rankFusionPipeline(query: string, limit: number, pool = 50) {
  const vStage = vectorStage(query, pool);
  return [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vStage }],
            lexical: [{ $search: lexicalSearchStage(query) }, { $limit: pool }],
          },
        },
        combination: { weights: { vector: 0.5, lexical: 0.5 } },
        scoreDetails: true,
      },
    },
    { $limit: limit },
    {
      $project: {
        ...PROJECT_DISPLAY,
        score: { $meta: "score" },
        scoreDetails: { $meta: "scoreDetails" },
      },
    },
  ];
}

const AUTO_EMBED_FEATURE: MongoFeature = isAtlasEmbedding()
  ? {
      name: "Atlas Automatic Embedding",
      detail: `The vector index is an autoEmbed index on 'chunkText' using ${env.atlasAutoEmbedModel}. Atlas embeds stored documents on insert/update and embeds the query string at search time — no client-side embedding call.`,
    }
  : {
      name: "Voyage embeddings (explicit)",
      detail: `Documents and the query are embedded client-side with ${env.voyageEmbedModel} and stored in the 'embedding' field, searched via $vectorSearch.`,
    };

export interface ExplainOptions {
  includeObsolete?: boolean;
  applyCorrections?: boolean;
  expandAliases?: boolean;
  applyPolicies?: boolean;
}

/** Lifecycle / correction / alias features shared across modes (iteration 2). */
function lifecycleFeatures(opts: ExplainOptions = {}): MongoFeature[] {
  const feats: MongoFeature[] = [];
  if (opts.expandAliases !== false) {
    feats.push({
      name: "Alias-aware query expansion",
      detail:
        "The query is expanded with known property aliases from the property_aliases master (EN / ZH / historical names) so a search for 形點 also benefits from YOHO Mall and vice-versa.",
    });
  }
  if (opts.includeObsolete !== true) {
    feats.push({
      name: "Version-aware filter (prefer newest)",
      detail:
        "A { obsoleteFlag: { $ne: true } } filter is applied to both the vector and lexical arms so superseded document versions are excluded by default. Toggle 'Include obsolete' to search historical versions.",
    });
  }
  if (opts.applyPolicies !== false) {
    feats.push({
      name: "Knowledge Policy Layer (governed, deterministic)",
      detail:
        "Approved KnowledgePolicy records (from human-reviewed CorrectionProposals) are resolved deterministically at query time: scope + match-condition gating, priority/specificity conflict resolution, then policy-driven query expansion, source boost/demote/exclude, version preference, and authoritative term meanings for answer grounding. AI proposes; humans approve; runtime applies the approved policy as the source of truth. Every application is written to a PolicyApplicationTrace for audit.",
    });
  }
  if (opts.applyCorrections !== false) {
    feats.push({
      name: "Legacy human-correction overlay (deprecated)",
      detail:
        "Older reviewer corrections (pin / demote / term-meaning) from user_corrections still apply as a secondary overlay for backward compatibility. New corrections should flow through the Knowledge Policy Layer.",
    });
  }
  return feats;
}

export function explainForMode(
  mode: RetrievalMode | "rag",
  query: string,
  limit = 8,
  opts: ExplainOptions = {}
): ModeExplain {
  const coll = `${env.dbName}.${env.collectionName}`;
  const lifecycle = lifecycleFeatures(opts);

  switch (mode) {
    case "vector":
      return {
        mode,
        title: "Vector only",
        features: [
          {
            name: "Atlas Vector Search ($vectorSearch)",
            detail:
              "Approximate nearest-neighbour semantic search over the vector index using cosine similarity. Score exposed via { $meta: 'vectorSearchScore' }.",
          },
          AUTO_EMBED_FEATURE,
          {
            name: "Aggregation $project / $meta",
            detail:
              "Projects display fields and surfaces the relevance score from search metadata.",
          },
          ...lifecycle,
        ],
        stages: [
          {
            label: "Atlas Vector Search",
            collection: coll,
            pipeline: vectorPipeline(query, limit),
          },
        ],
        notes:
          "Pure semantic retrieval. Understands intent but can miss exact property aliases / precise policy wording.",
      };

    case "vector-primary":
      return {
        mode,
        title: `Vector · ${env.atlasAutoEmbedModel}`,
        features: [
          {
            name: "Atlas Vector Search ($vectorSearch)",
            detail: `Semantic search over the primary index "${env.vectorIndex}" using the ${env.atlasAutoEmbedModel} embedding (Atlas Automatic Embedding). Score via { $meta: 'vectorSearchScore' }.`,
          },
          AUTO_EMBED_FEATURE,
          ...lifecycle,
        ],
        stages: [
          {
            label: `Atlas Vector Search — ${env.atlasAutoEmbedModel}`,
            collection: coll,
            pipeline: vectorPipeline(query, limit),
          },
        ],
        notes: `Baseline model for the comparison: ${env.atlasAutoEmbedModel} (Atlas auto-embedding).`,
      };

    case "vector-multimodal":
      return {
        mode,
        title: `Vector · ${env.multimodalEmbedModel}`,
        features: [
          {
            name: "Atlas Vector Search ($vectorSearch)",
            detail: `Semantic search over the secondary index "${env.vectorIndexMultimodal}" using the ${env.multimodalEmbedModel} embedding stored in the 'embeddingMultimodal' field. Score via { $meta: 'vectorSearchScore' }.`,
          },
          {
            name: `${env.multimodalEmbedModel} (client-side embedding)`,
            detail:
              "A multimodal embedding model (shares an embedding space across text + images). Vectors are generated via the Atlas Model API (Voyage AI by MongoDB) and stored explicitly, so this model's ranking can be compared against the text-only baseline.",
          },
          ...lifecycle,
        ],
        stages: [
          {
            label: `Atlas Vector Search — ${env.multimodalEmbedModel}`,
            collection: coll,
            pipeline: multimodalVectorPipeline(query, limit),
          },
        ],
        notes: `Comparison model: ${env.multimodalEmbedModel}. Compare its ordering against ${env.atlasAutoEmbedModel} for the same query.`,
      };

    case "hybrid":
      return {
        mode,
        title: "Hybrid Search",
        features: [
          {
            name: "$rankFusion (native hybrid search)",
            detail:
              "A single MongoDB aggregation stage runs both sub-pipelines and fuses them server-side with Reciprocal Rank Fusion (RRF, k=60). No application-side merging — one unified query. scoreDetails exposes each arm's rank and weight.",
          },
          {
            name: "Atlas Vector Search ($vectorSearch)",
            detail: "Semantic sub-pipeline inside $rankFusion.",
          },
          {
            name: "Atlas Search ($search, BM25)",
            detail:
              "Lexical sub-pipeline. exactTerms / propertyAliases / propertyName are boosted x5 so exact entity matches and policy phrases are not lost. Fuzzy maxEdits:1 tolerates minor typos.",
          },
          AUTO_EMBED_FEATURE,
          ...lifecycle,
        ],
        stages: [
          {
            label: "Unified hybrid search — $rankFusion",
            collection: coll,
            pipeline: rankFusionPipeline(query, limit),
          },
        ],
        notes:
          "One pipeline: $rankFusion fuses the vector and lexical sub-pipelines server-side with weighted RRF. Tune the vector/lexical weights via the slider in the UI. This is where exact aliases like 形點 / 環球貿易廣場 win.",
      };

    case "rerank":
      return {
        mode,
        title: "Vector + Reranker",
        features: [
          {
            name: "Atlas Vector Search + Atlas Search",
            detail:
              "A wide candidate pool (~25) is gathered from both the vector and lexical arms.",
          },
          AUTO_EMBED_FEATURE,
          {
            name: `Atlas Reranker (Voyage ${env.voyageRerankModel} via MongoDB)`,
            detail:
              "A cross-encoder reranks the candidate chunkText against the query for precise final ordering, served through Voyage AI by MongoDB (Atlas Model API). Score = relevance_score from the reranker.",
          },
          ...lifecycle,
        ],
        stages: [
          {
            label: "Candidate pool — Atlas Vector Search",
            collection: coll,
            pipeline: vectorPipeline(query, 25, 200),
          },
          {
            label: "Candidate pool — Atlas Search (lexical)",
            collection: coll,
            pipeline: lexicalPipeline(query, 25),
          },
        ],
        notes:
          "After Atlas returns candidates, the Atlas-hosted reranker (Voyage AI by MongoDB) reorders them. Reranking improves final ordering once retrieval recall is good.",
      };

    case "rag":
      return {
        mode,
        title: "RAG Q&A",
        features: [
          {
            name: "Atlas retrieval (Vector + Search + Atlas rerank)",
            detail:
              "Context chunks are retrieved with the best available mode (rerank if a reranker key is present, else hybrid).",
          },
          AUTO_EMBED_FEATURE,
          {
            name: `Atlas Reranker (Voyage ${env.voyageRerankModel} via MongoDB)`,
            detail: "Selects the most relevant chunks to ground the answer.",
          },
          {
            name: "Grounded generation (LLM)",
            detail: `Retrieved chunks are passed as context to ${env.llmModel}; the model answers only from context and cites [docId] sources. Reviewer term-clarifications are injected as authoritative grounding context.`,
          },
          ...lifecycle,
        ],
        stages: [
          {
            label: "Context retrieval — Atlas Vector Search",
            collection: coll,
            pipeline: vectorPipeline(query, 25, 200),
          },
          {
            label: "Context retrieval — Atlas Search (lexical)",
            collection: coll,
            pipeline: lexicalPipeline(query, 25),
          },
        ],
        notes:
          "Retrieval first, generation second. The grounded answer cites the exact docIds used as evidence.",
      };
  }
}
