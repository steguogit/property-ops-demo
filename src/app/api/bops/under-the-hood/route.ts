// "Under the hood" — sanitized collection config, the real aggregation
// pipelines used, index info, and last processing times. No secrets/credentials.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { BOPS, BOPS_INDEXES, ANOMALY_RULE, CORRELATION, TELEMETRY } from "@/lib/bops/config";
import { buildDetectionPipeline } from "@/lib/bops/anomaly";
import { buildKeywordPipeline, buildVectorPipeline, searchReadiness } from "@/lib/bops/knowledge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId") || "RUN-<current>";
  const assetId = req.nextUrl.searchParams.get("assetId") || "CHILLER-01";

  try {
    const db = await getDb();
    const infos = await db
      .listCollections({ name: { $in: Object.values(BOPS) } as any })
      .toArray();
    const collMeta = infos.map((i: any) => ({
      name: i.name,
      type: i.type,
      timeseries: i.options?.timeseries ?? null,
      expireAfterSeconds: i.options?.expireAfterSeconds ?? null,
    }));

    const readiness = await searchReadiness();

    return NextResponse.json({
      note:
        "Synthetic inputs (simulator telemetry + security events) are generated " +
        "deterministically. Everything below — time-series storage, rolling-window " +
        "detection, chart aggregation, Atlas Search and Vector Search — is REAL " +
        "MongoDB processing. Windowing and chart aggregations are MongoDB aggregation " +
        "capabilities used with telemetry, not exclusive to time-series collections.",
      collections: collMeta,
      indexes: {
        knowledgeLexical: { name: BOPS_INDEXES.knowledgeLexical, status: readiness.lexical },
        knowledgeVector: {
          name: BOPS_INDEXES.knowledgeVector,
          status: readiness.vector,
          embedding: "Atlas automatic embedding (voyage-4) over chunkText",
        },
      },
      retention: {
        telemetryExpireAfterSeconds: TELEMETRY.expireAfterSeconds,
        note: "Time-series expiry is bucket-based and asynchronous. Reset is instant at the UI level because the UI switches runs; old data expires later via TTL.",
      },
      rule: {
        id: ANOMALY_RULE.id,
        version: ANOMALY_RULE.version,
        name: ANOMALY_RULE.name,
        primarySignal: ANOMALY_RULE.primarySignal,
        baselineWindowSeconds: ANOMALY_RULE.baselineWindowSeconds,
        thresholdDeltaC: ANOMALY_RULE.thresholdDeltaC,
        minBaselineSamples: ANOMALY_RULE.minBaselineSamples,
        consecutiveBreaches: ANOMALY_RULE.consecutiveBreaches,
        correlationWindow: CORRELATION,
      },
      pipelines: {
        detection: buildDetectionPipeline(runId, assetId),
        chartMinuteAgg: "see /api/bops/telemetry?mode=agg (dateTrunc + group avg/min/max)",
        keywordSearch: buildKeywordPipeline("chiller vibration", { equipmentType: "chiller" as any }, 6),
        vectorSearch: buildVectorPipeline(
          "cooling output worsening while the machine shakes more and draws extra power",
          { equipmentType: "chiller" as any },
          6
        ),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
