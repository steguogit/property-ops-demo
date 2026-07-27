import { NextResponse } from "next/server";
import {
  getCollection,
  getDocumentsCollection,
  getCorrectionsCollection,
  getAliasesCollection,
} from "@/lib/mongo";
import { env, hasVoyage, hasReranker, hasLLM } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const status: Record<string, unknown> = {
    db: env.dbName,
    collection: env.collectionName,
    vectorIndex: env.vectorIndex,
    searchIndex: env.searchIndex,
    embeddingStrategy: env.embeddingStrategy,
    embedModel:
      env.embeddingStrategy === "atlas"
        ? `Atlas auto · ${env.atlasAutoEmbedModel}`
        : env.voyageEmbedModel,
    rerankModel: env.voyageRerankModel,
    rerankVia: env.rerankBaseUrl.includes("ai.mongodb.com")
      ? "Voyage AI by MongoDB (Atlas Model API)"
      : env.rerankBaseUrl,
    rerankerConfigured: hasReranker(),
    voyageConfigured: hasVoyage(),
    llmConfigured: hasLLM(),
    llmProvider: env.llmProvider,
    llmModel: env.llmModel,
  };

  try {
    const col = await getCollection();
    status.chunkCount = await col.countDocuments();
    status.mongoConnected = true;
    // Iteration-2 collection counts (best-effort; collections may be empty).
    try {
      status.documentCount = await (
        await getDocumentsCollection()
      ).countDocuments();
      status.correctionCount = await (
        await getCorrectionsCollection()
      ).countDocuments({ active: true });
      status.aliasCount = await (
        await getAliasesCollection()
      ).countDocuments();
    } catch {
      status.documentCount = 0;
      status.correctionCount = 0;
      status.aliasCount = 0;
    }
  } catch (e) {
    status.mongoConnected = false;
    status.mongoError = (e as Error).message;
    status.chunkCount = 0;
  }

  return NextResponse.json(status);
}
