// Telemetry chart data for an asset. Bounded by run + asset + time window.
//   GET ?runId&assetId&mode=raw|agg&startMs&endMs&signals=a,b,c
import { NextRequest, NextResponse } from "next/server";
import { rawSeries, minuteAggSeries } from "@/lib/bops/telemetry";
import { SIGNALS, SignalKey } from "@/lib/bops/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const runId = q.get("runId") || "";
  const assetId = q.get("assetId") || "";
  if (!runId || !assetId) {
    return NextResponse.json({ error: "runId and assetId required" }, { status: 400 });
  }
  const mode = q.get("mode") === "agg" ? "agg" : "raw";
  const endMs = Number(q.get("endMs")) || Date.now();
  const startMs = Number(q.get("startMs")) || endMs - 15 * 60 * 1000;

  // Validate signals against the known set.
  const requested = (q.get("signals") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SignalKey[];
  const signals = requested.filter((s) => s in SIGNALS);
  if (!signals.length) {
    return NextResponse.json({ error: "no valid signals requested" }, { status: 400 });
  }

  try {
    const res =
      mode === "agg"
        ? await minuteAggSeries(runId, assetId, startMs, endMs, signals)
        : await rawSeries(runId, assetId, startMs, endMs, signals);
    return NextResponse.json({
      mode,
      assetId,
      signals: signals.map((s) => ({ key: s, label: SIGNALS[s].label, unit: SIGNALS[s].unit })),
      points: res.points,
      queryMs: res.ms,
      pipeline: res.pipeline,
      window: { startMs, endMs },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
