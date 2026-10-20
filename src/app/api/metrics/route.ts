import { NextRequest, NextResponse } from "next/server";
import {
  getCollection,
  getDocumentsCollection,
  getIngestionJobsCollection,
  getUsageEventsCollection,
  getAliasesCollection,
  getCorrectionsCollection,
  getPoliciesCollection,
  getDatasetsCollection,
} from "@/lib/mongo";
import { datasetFilter } from "@/lib/datasets";

export const dynamic = "force-dynamic";

/** Turn a `[{_id, count}]` group result into a plain `{ key: count }` map. */
function toMap(rows: { _id: unknown; count: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r._id ?? "unknown")] = r.count;
  return out;
}

/**
 * Dashboard metrics endpoint. Aggregates — scoped to the active demo dataset
 * when `datasetId` is supplied — across five areas:
 *   1. Corpus      (documents, chunks, aliases, breakdowns by type/property)
 *   2. Ingestion   (recent uploads, OCR usage, embedding status, avg step times)
 *   3. Governance  (review status, signature status, obsolete vs current)
 *   4. Retrieval   (model-call activity derived from usage events + corrections/policies)
 *   5. Tokens      (total token consumption by provider / operation / model)
 * Everything is best-effort: a failing sub-aggregation degrades to zeros rather
 * than failing the whole dashboard.
 */
export async function GET(req: NextRequest) {
  const datasetId = req.nextUrl.searchParams.get("datasetId") || undefined;
  const scope = datasetId ? (datasetFilter(datasetId) as any) : {};

  const result: Record<string, unknown> = { datasetId: datasetId ?? null };

  try {
    const [chunks, docsCol, jobsCol, usageCol, aliasesCol, corrCol, polCol] =
      await Promise.all([
        getCollection(),
        getDocumentsCollection(),
        getIngestionJobsCollection(),
        getUsageEventsCollection(),
        getAliasesCollection(),
        getCorrectionsCollection(),
        getPoliciesCollection(),
      ]);

    // ---------------- 1. Corpus ----------------
    const [
      chunkCount,
      documentCount,
      aliasCount,
      byType,
      byProperty,
      byFileType,
    ] = await Promise.all([
      chunks.countDocuments(scope),
      docsCol.countDocuments(scope),
      aliasesCol.countDocuments(),
      docsCol
        .aggregate([
          { $match: scope },
          { $group: { _id: "$docType", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .toArray(),
      docsCol
        .aggregate([
          { $match: scope },
          { $group: { _id: "$propertyName", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 8 },
        ])
        .toArray(),
      docsCol
        .aggregate([
          { $match: scope },
          { $group: { _id: "$sourceFileType", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .toArray(),
    ]);

    result.corpus = {
      chunkCount,
      documentCount,
      aliasCount,
      byDocType: toMap(byType as any),
      byProperty: toMap(byProperty as any),
      byFileType: toMap(byFileType as any),
    };

    // ---------------- 2. Ingestion ----------------
    const [ocrAgg, embedStatus, recentUploads, stepAvgRows] = await Promise.all([
      docsCol
        .aggregate([
          { $match: scope },
          { $group: { _id: "$ocrUsed", count: { $sum: 1 } } },
        ])
        .toArray(),
      docsCol
        .aggregate([
          { $match: scope },
          { $group: { _id: "$embeddingStatus", count: { $sum: 1 } } },
        ])
        .toArray(),
      docsCol
        .find(scope)
        .sort({ uploadedAt: -1 })
        .limit(6)
        .project({
          documentId: 1,
          title: 1,
          sourceFileType: 1,
          chunkCount: 1,
          ocrUsed: 1,
          status: 1,
          uploadedAt: 1,
          _id: 0,
        })
        .toArray(),
      // Average per-step durations across all ingestion jobs (unwound steps).
      jobsCol
        .aggregate([
          { $unwind: "$steps" },
          {
            $group: {
              _id: "$steps.step",
              avgMs: { $avg: "$steps.ms" },
              count: { $sum: 1 },
            },
          },
          { $sort: { avgMs: -1 } },
        ])
        .toArray(),
    ]);

    const ocrMap = toMap(ocrAgg as any);
    result.ingestion = {
      jobCount: await jobsCol.countDocuments({}),
      ocrUsed: ocrMap["true"] ?? 0,
      ocrNotUsed: ocrMap["false"] ?? 0,
      embeddingStatus: toMap(embedStatus as any),
      recentUploads,
      avgStepMs: (stepAvgRows as any[]).map((r) => ({
        step: r._id,
        avgMs: Math.round(r.avgMs ?? 0),
        count: r.count,
      })),
    };

    // ---------------- 3. Governance ----------------
    const [reviewAgg, sigAgg, obsoleteCount, currentCount, activePolicies, activeCorrections] =
      await Promise.all([
        docsCol
          .aggregate([
            { $match: scope },
            { $group: { _id: "$reviewStatus", count: { $sum: 1 } } },
          ])
          .toArray(),
        docsCol
          .aggregate([
            { $match: scope },
            { $group: { _id: "$signatureStatus", count: { $sum: 1 } } },
          ])
          .toArray(),
        docsCol.countDocuments({ ...scope, obsoleteFlag: true }),
        docsCol.countDocuments({ ...scope, obsoleteFlag: { $ne: true } }),
        polCol.countDocuments({ status: "active" }).catch(() => 0),
        corrCol.countDocuments({ active: true }).catch(() => 0),
      ]);

    result.governance = {
      reviewStatus: toMap(reviewAgg as any),
      signatureStatus: toMap(sigAgg as any),
      obsoleteCount,
      currentCount,
      activePolicies,
      activeCorrections,
    };

    // ---------------- 4 & 5. Retrieval activity + Tokens ----------------
    const usageScope = datasetId ? { datasetId } : {};
    const [tokenTotals, byOperation, byProvider, byModel, recentUsage] =
      await Promise.all([
        usageCol
          .aggregate([
            { $match: usageScope },
            {
              $group: {
                _id: null,
                totalTokens: { $sum: "$totalTokens" },
                promptTokens: { $sum: "$promptTokens" },
                completionTokens: { $sum: "$completionTokens" },
                calls: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        usageCol
          .aggregate([
            { $match: usageScope },
            {
              $group: {
                _id: "$operation",
                tokens: { $sum: "$totalTokens" },
                calls: { $sum: 1 },
              },
            },
            { $sort: { tokens: -1 } },
          ])
          .toArray(),
        usageCol
          .aggregate([
            { $match: usageScope },
            {
              $group: {
                _id: "$provider",
                tokens: { $sum: "$totalTokens" },
                calls: { $sum: 1 },
              },
            },
            { $sort: { tokens: -1 } },
          ])
          .toArray(),
        usageCol
          .aggregate([
            { $match: usageScope },
            {
              $group: {
                _id: "$model",
                tokens: { $sum: "$totalTokens" },
                calls: { $sum: 1 },
              },
            },
            { $sort: { tokens: -1 } },
          ])
          .toArray(),
        usageCol
          .find(usageScope)
          .sort({ createdAt: -1 })
          .limit(8)
          .project({ _id: 0 })
          .toArray(),
      ]);

    const totals = (tokenTotals[0] as any) ?? {};
    result.tokens = {
      totalTokens: totals.totalTokens ?? 0,
      promptTokens: totals.promptTokens ?? 0,
      completionTokens: totals.completionTokens ?? 0,
      calls: totals.calls ?? 0,
      byOperation: (byOperation as any[]).map((r) => ({
        operation: r._id,
        tokens: r.tokens,
        calls: r.calls,
      })),
      byProvider: (byProvider as any[]).map((r) => ({
        provider: r._id,
        tokens: r.tokens,
        calls: r.calls,
      })),
      byModel: (byModel as any[]).map((r) => ({
        model: r._id,
        tokens: r.tokens,
        calls: r.calls,
      })),
      recent: recentUsage,
    };

    // Retrieval activity derived from the model-call audit trail.
    const retrievalOps = new Set(["rag", "generate", "chat", "rerank", "embed"]);
    result.retrieval = {
      modelCalls: (byOperation as any[])
        .filter((r) => retrievalOps.has(r._id))
        .map((r) => ({ operation: r._id, calls: r.calls })),
      totalCalls: totals.calls ?? 0,
    };

    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = (e as Error).message;
  }

  return NextResponse.json(result);
}
