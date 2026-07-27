import { env, hasVoyage, hasReranker } from "./env";

const VOYAGE_BASE = "https://api.voyageai.com/v1";

/**
 * Generate embeddings via Voyage AI.
 * @param texts  array of strings to embed
 * @param inputType "document" for stored chunks, "query" for search queries
 */
export async function voyageEmbed(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (!hasVoyage()) {
    throw new Error("VOYAGE_API_KEY is not set - cannot generate embeddings.");
  }
  const res = await fetch(`${VOYAGE_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.voyageApiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: env.voyageEmbedModel,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embeddings error ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  // Sort by index to preserve input order.
  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// Short-lived cache of query embeddings. This is the key rate-limit mitigation:
// a single user query triggers vector + hybrid + rerank, which would otherwise
// re-embed the same query 3-4 times. With the cache, it is embedded ONCE.
const queryCache = new Map<string, { vector: number[]; ts: number }>();
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;

export async function voyageEmbedOne(
  text: string,
  inputType: "document" | "query" = "query"
): Promise<number[]> {
  if (inputType === "query") {
    const key = `${env.voyageEmbedModel}::${text}`;
    const hit = queryCache.get(key);
    if (hit && Date.now() - hit.ts < QUERY_CACHE_TTL_MS) {
      return hit.vector;
    }
    const [v] = await voyageEmbed([text], "query");
    queryCache.set(key, { vector: v, ts: Date.now() });
    return v;
  }
  const [v] = await voyageEmbed([text], inputType);
  return v;
}

// ---------------------------------------------------------------------------
// Multimodal embeddings (voyage-multimodal-3.5) via the Atlas Model API gateway
// (Voyage AI by MongoDB). Different endpoint + body shape from text embeddings:
// POST /multimodalembeddings with an `inputs` array of { content: [...] } where
// each content part is { type: "text", text } (or image parts). We only use
// text parts here (chunkText / query), but the model shares an embedding space
// with images so it's a fair multimodal-vs-text comparison target.
// ---------------------------------------------------------------------------
export async function voyageEmbedMultimodal(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (!env.rerankApiKey) {
    throw new Error(
      "No model API key set - set ATLAS_MODEL_API_KEY to use multimodal embeddings."
    );
  }
  const res = await fetch(`${env.rerankBaseUrl}/multimodalembeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.rerankApiKey}`,
    },
    body: JSON.stringify({
      inputs: texts.map((t) => ({ content: [{ type: "text", text: t }] })),
      model: env.multimodalEmbedModel,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Multimodal embeddings error ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Short-lived cache of multimodal query embeddings (mirrors voyageEmbedOne).
const mmQueryCache = new Map<string, { vector: number[]; ts: number }>();

export async function voyageEmbedMultimodalOne(
  text: string,
  inputType: "document" | "query" = "query"
): Promise<number[]> {
  if (inputType === "query") {
    const key = `${env.multimodalEmbedModel}::${text}`;
    const hit = mmQueryCache.get(key);
    if (hit && Date.now() - hit.ts < QUERY_CACHE_TTL_MS) {
      return hit.vector;
    }
    const [v] = await voyageEmbedMultimodal([text], "query");
    mmQueryCache.set(key, { vector: v, ts: Date.now() });
    return v;
  }
  const [v] = await voyageEmbedMultimodal([text], inputType);
  return v;
}

/**
 * Embed IMAGES with voyage-multimodal-3.5 (same shared text/image space). Each
 * image is sent as a base64 data URI content part. Returns one vector per image,
 * in input order. Used for signature comparison (image-to-image similarity).
 */
export async function voyageEmbedMultimodalImages(
  images: { buffer: Buffer; mime: string }[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (!env.rerankApiKey) {
    throw new Error(
      "No model API key set - set ATLAS_MODEL_API_KEY to use multimodal embeddings."
    );
  }
  const res = await fetch(`${env.rerankBaseUrl}/multimodalembeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.rerankApiKey}`,
    },
    body: JSON.stringify({
      inputs: images.map((im) => ({
        content: [
          {
            type: "image_base64",
            image_base64: `data:${im.mime};base64,${im.buffer.toString(
              "base64"
            )}`,
          },
        ],
      })),
      model: env.multimodalEmbedModel,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Multimodal image embeddings error ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function voyageEmbedMultimodalImageOne(
  buffer: Buffer,
  mime: string,
  inputType: "document" | "query" = "document"
): Promise<number[]> {
  const [v] = await voyageEmbedMultimodalImages([{ buffer, mime }], inputType);
  return v;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/**
 * Rerank candidate documents against a query using a Voyage reranker model.
 *
 * The request is routed through the configured rerank endpoint — by default
 * "Voyage AI by MongoDB" (https://ai.mongodb.com/v1/rerank) authenticated with
 * an Atlas Model API key. This is Voyage-API-compatible, so the request/response
 * shape is unchanged; it just uses Atlas usage-tier rate limits instead of a
 * personal Voyage free-tier key. Returns results sorted by relevance (highest
 * first).
 */
export async function voyageRerank(
  query: string,
  documents: string[],
  topK?: number
): Promise<RerankResult[]> {
  if (!hasReranker()) {
    throw new Error(
      "No reranker API key set - set ATLAS_MODEL_API_KEY (or VOYAGE_API_KEY) to enable reranking."
    );
  }
  const res = await fetch(`${env.rerankBaseUrl}/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.rerankApiKey}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model: env.voyageRerankModel,
      top_k: topK ?? documents.length,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Rerank error ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    data: { index: number; relevance_score: number }[];
  };
  return json.data
    .map((d) => ({ index: d.index, relevanceScore: d.relevance_score }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}
