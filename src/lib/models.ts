import { env, isAtlasEmbedding, hasLLM } from "./env";

/** A model used by an operation, with its role in the pipeline. */
export interface ModelUsage {
  /** e.g. "embedding" | "reranker" | "generation" */
  role: string;
  name: string;
}

/** The primary text-embedding model for the active strategy. */
function primaryEmbedModel(): string {
  return isAtlasEmbedding()
    ? `${env.atlasAutoEmbedModel} (Atlas auto)`
    : env.voyageEmbedModel;
}

/**
 * Which AI models a retrieval mode actually uses. Single source of truth for
 * surfacing "models used" in the UI for the Compare and RAG features.
 */
export function modelsForMode(
  mode:
    | "vector"
    | "hybrid"
    | "rerank"
    | "vector-primary"
    | "vector-multimodal"
    | "rag"
): ModelUsage[] {
  switch (mode) {
    case "vector":
    case "vector-primary":
      return [{ role: "embedding", name: primaryEmbedModel() }];
    case "vector-multimodal":
      return [{ role: "embedding", name: env.multimodalEmbedModel }];
    case "hybrid":
      return [
        { role: "embedding", name: primaryEmbedModel() },
        { role: "lexical", name: "Atlas Search (BM25)" },
      ];
    case "rerank":
      return [
        { role: "embedding", name: primaryEmbedModel() },
        { role: "lexical", name: "Atlas Search (BM25)" },
        { role: "reranker", name: env.voyageRerankModel },
      ];
    case "rag":
      return [
        { role: "embedding", name: primaryEmbedModel() },
        { role: "reranker", name: env.voyageRerankModel },
        {
          role: "generation",
          name: hasLLM() ? env.llmModel : "extractive (no LLM)",
        },
      ];
    default:
      return [];
  }
}
