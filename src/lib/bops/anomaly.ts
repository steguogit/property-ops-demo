// =============================================================================
// Anomaly detection — a real rolling-window aggregation over PERSISTED
// telemetry. This does NOT run from a frontend timer or the fault endpoint.
//
// Rule (chiller cooling-performance degradation):
//   * Partition by (runId, assetId).
//   * Rolling baseline = mean of primarySignal over the trailing window,
//     EXCLUDING the most recent few seconds (so the current observation does
//     not pollute its own baseline and the gradual fault cannot "hide" in an
//     adapting mean).
//   * A sample breaches when (observed - baselineMean) >= thresholdDeltaC.
//   * Requires >= minBaselineSamples valid baseline samples (warm-up guard).
//   * Requires `consecutiveBreaches` breaching samples in a row (noise guard).
//   * Deduplicated: one open/ack incident per (runId, assetId, rule) at a time.
//   * A dismissed incident is NOT immediately reopened for the same ongoing
//     episode (cooldown).
// =============================================================================
import { ANOMALY_RULE, SIGNALS, CORRELATION, SITE } from "./config";
import { incidentsCol, telemetryCol, eventsCol } from "./mongo";
import type {
  DetectionEvidence,
  IncidentDoc,
  CorrelatedEventRef,
} from "./mongo";

/** Build the detection aggregation pipeline (also surfaced in "Under the hood"). */
export function buildDetectionPipeline(runId: string, assetId: string): object[] {
  const primary = ANOMALY_RULE.primarySignal;
  const baselineStart = -ANOMALY_RULE.baselineWindowSeconds;
  const baselineEnd = -ANOMALY_RULE.baselineExcludeRecentSeconds;
  return [
    { $match: { "meta.runId": runId, "meta.assetId": assetId, [primary]: { $ne: null } } },
    { $sort: { ts: 1 } },
    {
      $setWindowFields: {
        partitionBy: { runId: "$meta.runId", assetId: "$meta.assetId" },
        sortBy: { ts: 1 },
        output: {
          baselineMean: {
            $avg: `$${primary}`,
            window: { range: [baselineStart, baselineEnd], unit: "second" },
          },
          baselineCount: {
            $count: {},
            window: { range: [baselineStart, baselineEnd], unit: "second" },
          },
        },
      },
    },
    {
      $addFields: {
        deltaOverBaseline: { $subtract: [`$${primary}`, "$baselineMean"] },
        breach: {
          $and: [
            { $gte: ["$baselineCount", ANOMALY_RULE.minBaselineSamples] },
            {
              $gte: [
                { $subtract: [`$${primary}`, "$baselineMean"] },
                ANOMALY_RULE.thresholdDeltaC,
              ],
            },
          ],
        },
      },
    },
  ];
}

export interface DetectionResultSample {
  ts: Date;
  observed: number;
  baselineMean: number;
  baselineCount: number;
  deltaOverBaseline: number;
  breach: boolean;
}

/** Run the detection pipeline and return the per-sample series (chronological). */
export async function runDetection(
  runId: string,
  assetId: string
): Promise<DetectionResultSample[]> {
  const col = await telemetryCol();
  const primary = ANOMALY_RULE.primarySignal;
  const pipeline = [
    ...buildDetectionPipeline(runId, assetId),
    {
      $project: {
        _id: 0,
        ts: 1,
        observed: `$${primary}`,
        baselineMean: 1,
        baselineCount: 1,
        deltaOverBaseline: 1,
        breach: 1,
      },
    },
  ];
  return col.aggregate<DetectionResultSample>(pipeline).toArray();
}

/**
 * Pure classifier mirroring the server-side $addFields breach logic, so the
 * threshold / min-sample behavior is unit-testable without a database. Given a
 * reading's observed value, its rolling baseline mean and the baseline sample
 * count, returns whether it breaches.
 */
export function classifyBreach(
  observed: number,
  baselineMean: number,
  baselineCount: number
): boolean {
  if (baselineCount < ANOMALY_RULE.minBaselineSamples) return false; // warm-up guard
  return observed - baselineMean >= ANOMALY_RULE.thresholdDeltaC;
}

/** Find the end of the latest run of `n` consecutive breaches, or null. */
export function latestConsecutiveBreach(
  samples: DetectionResultSample[],
  n: number
): { index: number; run: DetectionResultSample[] } | null {
  let streak = 0;
  let last: { index: number; run: DetectionResultSample[] } | null = null;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].breach) {
      streak++;
      if (streak >= n) last = { index: i, run: samples.slice(i - n + 1, i + 1) };
    } else {
      streak = 0;
    }
  }
  return last;
}

/**
 * Evaluate a run+asset and persist an incident if the rule fires (deduped).
 * Returns the incidentId if an incident exists (new or pre-existing open), else
 * null. This is the real backend processor invoked by polling.
 */
export async function evaluateAndPersist(
  runId: string,
  assetId: string
): Promise<{ incidentId: string | null; created: boolean; samples: number; pipelineMs: number }> {
  const t0 = Date.now();
  const samples = await runDetection(runId, assetId);
  const pipelineMs = Date.now() - t0;

  const incCol = await incidentsCol();

  // Dedup: an already-open/acknowledged incident short-circuits creation, but we
  // still refresh correlation (late events).
  const existingOpen = await incCol.findOne({
    runId,
    assetId,
    ruleId: ANOMALY_RULE.id,
    status: { $in: ["open", "acknowledged"] },
  });
  if (existingOpen) {
    await refreshCorrelation(existingOpen.incidentId);
    return { incidentId: existingOpen.incidentId, created: false, samples: samples.length, pipelineMs };
  }

  const hit = latestConsecutiveBreach(samples, ANOMALY_RULE.consecutiveBreaches);
  if (!hit) return { incidentId: null, created: false, samples: samples.length, pipelineMs };

  const detSample = hit.run[hit.run.length - 1];
  const detectionTime = detSample.ts;

  // Cooldown: don't immediately reopen a dismissed incident for the same ongoing
  // episode (within the baseline window of the last dismissal).
  const recentlyDismissed = await incCol.findOne(
    {
      runId,
      assetId,
      ruleId: ANOMALY_RULE.id,
      status: { $in: ["dismissed", "resolved"] },
    },
    { sort: { updatedAt: -1 } }
  );
  if (recentlyDismissed) {
    const lastAt = new Date(recentlyDismissed.updatedAt).getTime();
    const cooldownMs = ANOMALY_RULE.baselineWindowSeconds * 1000;
    if (detectionTime.getTime() - lastAt < cooldownMs) {
      return { incidentId: null, created: false, samples: samples.length, pipelineMs };
    }
  }

  const evidence = buildEvidence(hit.run, detSample, samples, assetId);
  // Populate supporting signal values from the detection-time reading.
  const telCol = await telemetryCol();
  const detReading = await telCol.findOne({
    "meta.runId": runId,
    "meta.assetId": assetId,
    ts: detectionTime,
  });
  if (detReading) {
    for (const s of evidence.supporting) {
      const v = (detReading as any)[s.key];
      s.value = typeof v === "number" ? round2(v) : NaN;
    }
  }
  const incidentId = `INC-${runId}-${assetId}-${detectionTime.getTime()}`;

  const related = await correlateEvents(runId, assetId, detectionTime);

  const doc: IncidentDoc = {
    incidentId,
    runId,
    assetId,
    siteId: SITE.siteId,
    buildingId: SITE.buildingId,
    zoneId: await zoneForAsset(assetId),
    ruleId: ANOMALY_RULE.id,
    ruleVersion: ANOMALY_RULE.version,
    title: `${ANOMALY_RULE.name} — ${assetId}`,
    severity: "high",
    status: "open",
    evidence,
    relatedEvents: related,
    actions: [],
    detectedAt: detectionTime,
    updatedAt: new Date(),
  };
  // Idempotent insert (poll races): ignore duplicate key.
  try {
    await incCol.insertOne({ _id: incidentId, ...doc } as any);
    return { incidentId, created: true, samples: samples.length, pipelineMs };
  } catch (e: any) {
    if (e?.code === 11000) {
      return { incidentId, created: false, samples: samples.length, pipelineMs };
    }
    throw e;
  }
}

function buildEvidence(
  breachRun: DetectionResultSample[],
  detSample: DetectionResultSample,
  allSamples: DetectionResultSample[],
  _assetId: string
): DetectionEvidence {
  const primaryDef = SIGNALS[ANOMALY_RULE.primarySignal];
  const first = breachRun[0];
  return {
    ruleId: ANOMALY_RULE.id,
    ruleVersion: ANOMALY_RULE.version,
    ruleName: ANOMALY_RULE.name,
    primarySignal: ANOMALY_RULE.primarySignal,
    primaryUnit: primaryDef.unit,
    observedValue: detSample.observed,
    baselineMean: round2(detSample.baselineMean),
    baselineWindowSeconds: ANOMALY_RULE.baselineWindowSeconds,
    thresholdDeltaC: ANOMALY_RULE.thresholdDeltaC,
    deltaOverBaseline: round2(detSample.deltaOverBaseline),
    validSampleCount: detSample.baselineCount,
    consecutiveBreaches: breachRun.length,
    detectionTime: detSample.ts.toISOString(),
    telemetryIntervalStart: first.ts.toISOString(),
    telemetryIntervalEnd: detSample.ts.toISOString(),
    supporting: ANOMALY_RULE.supportingSignals.map((k) => ({
      key: k,
      label: SIGNALS[k].label,
      unit: SIGNALS[k].unit,
      value: NaN, // filled below from telemetry
    })),
  };
}

/** Correlate contextual events: same building+zone, within ±window of detection,
 *  current run. Uses event TIME (not ingestion time). Chronological order. */
export async function correlateEvents(
  runId: string,
  assetId: string,
  detectionTime: Date
): Promise<CorrelatedEventRef[]> {
  const zoneId = await zoneForAsset(assetId);
  const evCol = await eventsCol();
  const lo = new Date(detectionTime.getTime() - CORRELATION.windowSecondsBefore * 1000);
  const hi = new Date(detectionTime.getTime() + CORRELATION.windowSecondsAfter * 1000);
  const events = await evCol
    .find({
      runId,
      buildingId: SITE.buildingId,
      zoneId,
      eventTime: { $gte: lo, $lte: hi },
    })
    .sort({ eventTime: 1 })
    .toArray();
  return events.map((e) => ({
    eventId: e.eventId,
    eventType: e.eventType,
    eventTime: e.eventTime.toISOString(),
    zoneId: e.zoneId,
    severity: e.severity,
    offsetSeconds: Math.round((e.eventTime.getTime() - detectionTime.getTime()) / 1000),
  }));
}

/** Re-run correlation for an existing incident (supports late-arriving events). */
export async function refreshCorrelation(incidentId: string): Promise<void> {
  const incCol = await incidentsCol();
  const inc = await incCol.findOne({ incidentId });
  if (!inc) return;
  const related = await correlateEvents(inc.runId, inc.assetId, inc.detectedAt);
  await incCol.updateOne(
    { incidentId },
    { $set: { relatedEvents: related, updatedAt: new Date() } }
  );
}

async function zoneForAsset(assetId: string): Promise<string> {
  const { ASSET_SEEDS } = await import("./config");
  return ASSET_SEEDS.find((a) => a.assetId === assetId)?.zoneId ?? "UNKNOWN";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
