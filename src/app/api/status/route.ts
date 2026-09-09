import { NextRequest, NextResponse } from "next/server";
import {
  getCollection,
  getDocumentsCollection,
  getCorrectionsCollection,
  getAliasesCollection,
} from "@/lib/mongo";
import { env, hasVoyage, hasReranker, hasLLM } from "@/lib/env";
import { datasetFilter } from "@/lib/datasets";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Optional dataset scoping: when a datasetId is supplied, chunk/document
  // counts reflect only that demo (so the header shows the active demo's size).
  const datasetId = req.nextUrl.searchParams.get("datasetId") || undefined;
  const scope = datasetId ? (datasetFilter(datasetId) as any) : {};
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

  status.datasetId = datasetId ?? null;
  try {
    const col = await getCollection();
    status.chunkCount = await col.countDocuments(scope);
    status.mongoConnected = true;
    // Iteration-2 collection counts (best-effort; collections may be empty).
    try {
      status.documentCount = await (
        await getDocumentsCollection()
      ).countDocuments(scope);
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
