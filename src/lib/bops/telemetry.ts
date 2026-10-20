// =============================================================================
// Telemetry queries — bounded by run, asset and time. Two chart modes:
//   raw  — individual readings in the window.
//   agg  — one-minute average / min / max via a real aggregation ($dateTrunc +
//          $group). Windowing/bucketing are aggregation capabilities used WITH
//          telemetry; they are not exclusive to time-series collections.
// =============================================================================
import { telemetryCol } from "./mongo";
import { SIGNALS, SignalKey } from "./config";

export interface RawPoint {
  ts: string; // ISO
  [signal: string]: number | string;
}

const MAX_RANGE_MS = 6 * 60 * 60 * 1000; // hard cap: 6h
const MAX_POINTS = 5000;

function clampRange(startMs: number, endMs: number): [number, number] {
  let s = startMs;
  let e = endMs;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    e = Date.now();
    s = e - 15 * 60 * 1000;
  }
  if (e - s > MAX_RANGE_MS) s = e - MAX_RANGE_MS;
  return [s, e];
}

export async function rawSeries(
  runId: string,
  assetId: string,
  startMs: number,
  endMs: number,
  signals: SignalKey[]
): Promise<{ points: RawPoint[]; ms: number; pipeline: object[] }> {
  const [s, e] = clampRange(startMs, endMs);
  const col = await telemetryCol();
  const proj: Record<string, number> = { _id: 0, ts: 1 };
  for (const sig of signals) proj[sig] = 1;
  const pipeline: object[] = [
    {
      $match: {
        "meta.runId": runId,
        "meta.assetId": assetId,
        ts: { $gte: new Date(s), $lte: new Date(e) },
      },
    },
    { $sort: { ts: 1 } },
    { $limit: MAX_POINTS },
    { $project: proj },
  ];
  const t0 = Date.now();
  const rows = await col.aggregate(pipeline).toArray();
  const points = rows.map((r: any) => ({ ...r, ts: new Date(r.ts).toISOString() }));
  return { points, ms: Date.now() - t0, pipeline };
}

export async function minuteAggSeries(
  runId: string,
  assetId: string,
  startMs: number,
  endMs: number,
  signals: SignalKey[]
): Promise<{ points: any[]; ms: number; pipeline: object[] }> {
  const [s, e] = clampRange(startMs, endMs);
  const col = await telemetryCol();
  const groupAcc: Record<string, unknown> = { _id: { $dateTrunc: { date: "$ts", unit: "minute" } } };
  for (const sig of signals) {
    groupAcc[`${sig}_avg`] = { $avg: `$${sig}` };
    groupAcc[`${sig}_min`] = { $min: `$${sig}` };
    groupAcc[`${sig}_max`] = { $max: `$${sig}` };
  }
  const projOut: Record<string, unknown> = { _id: 0, ts: "$_id" };
  for (const sig of signals) {
    projOut[`${sig}_avg`] = { $round: [`$${sig}_avg`, 2] };
    projOut[`${sig}_min`] = { $round: [`$${sig}_min`, 2] };
    projOut[`${sig}_max`] = { $round: [`$${sig}_max`, 2] };
  }
  const pipeline: object[] = [
    {
      $match: {
        "meta.runId": runId,
        "meta.assetId": assetId,
        ts: { $gte: new Date(s), $lte: new Date(e) },
      },
    },
    { $group: groupAcc },
    { $sort: { _id: 1 } },
    { $project: projOut },
  ];
  const t0 = Date.now();
  const rows = await col.aggregate(pipeline).toArray();
  const points = rows.map((r: any) => ({ ...r, ts: new Date(r.ts).toISOString() }));
  return { points, ms: Date.now() - t0, pipeline };
}

/** Latest reading per telemetry asset for a run (dashboard cards). */
export async function latestByAsset(
  runId: string
): Promise<Record<string, { ts: string; values: Record<string, number>; ageMs: number }>> {
  const col = await telemetryCol();
  const rows = await col
    .aggregate([
      { $match: { "meta.runId": runId } },
      { $sort: { ts: -1 } },
      {
        $group: {
          _id: "$meta.assetId",
          ts: { $first: "$ts" },
          doc: { $first: "$$ROOT" },
        },
      },
    ])
    .toArray();
  const now = Date.now();
  const out: Record<string, { ts: string; values: Record<string, number>; ageMs: number }> = {};
  for (const r of rows as any[]) {
    const values: Record<string, number> = {};
    for (const k of Object.keys(SIGNALS)) {
      if (typeof r.doc[k] === "number") values[k] = r.doc[k];
    }
    out[r._id] = {
      ts: new Date(r.ts).toISOString(),
      values,
      ageMs: now - new Date(r.ts).getTime(),
    };
  }
  return out;
}

/** Sum of latest electrical input power across reporting mechanical assets.
 *  "Monitored equipment power" (instantaneous kW) — NOT accumulated energy. */
export async function monitoredEquipmentPowerKw(runId: string): Promise<{
  totalKw: number;
  reporting: number;
}> {
  const latest = await latestByAsset(runId);
  let total = 0;
  let reporting = 0;
  for (const assetId of Object.keys(latest)) {
    const p = latest[assetId].values.electricalInputPowerKw;
    if (typeof p === "number") {
      total += p;
      reporting++;
    }
  }
  return { totalKw: Math.round(total * 10) / 10, reporting };
}
