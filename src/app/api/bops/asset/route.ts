// Single asset detail (identity, specs, points) + current measurement snapshot
// and data-quality/staleness for the given run.
import { NextRequest, NextResponse } from "next/server";
import { assetsCol } from "@/lib/bops/mongo";
import { latestByAsset } from "@/lib/bops/telemetry";
import { getRun } from "@/lib/bops/runs";
import { TELEMETRY, SIGNALS } from "@/lib/bops/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const assetId = q.get("assetId") || "";
  const runId = q.get("runId") || "";
  if (!assetId) return NextResponse.json({ error: "assetId required" }, { status: 400 });

  try {
    const asset = await (await assetsCol()).findOne({ assetId });
    if (!asset) return NextResponse.json({ error: "asset not found" }, { status: 404 });

    let measurement: any = null;
    let enabledSignals: string[] = [];
    if (runId) {
      const latest = await latestByAsset(runId);
      const l = latest[assetId];
      const run = await getRun(runId);
      enabledSignals = run?.enabledSignals?.[assetId] ?? [];
      if (l) {
        const stale = l.ageMs > TELEMETRY.staleAfterMs;
        measurement = {
          ts: l.ts,
          ageMs: l.ageMs,
          stale,
          quality: stale ? "stale" : "good",
          values: l.values,
        };
      }
    }

    // Point metadata including additive signals enabled for this run.
    const points = asset.points.map((p) => ({
      ...p,
      enabled: !p.additive || enabledSignals.includes(p.key),
    }));
    // Surface additive signals that exist in the catalog but aren't default points.
    const additive = Object.values(SIGNALS)
      .filter((s) => (s as any).additive)
      .map((s) => ({
        key: s.key,
        label: s.label,
        unit: s.unit,
        additive: true,
        enabled: enabledSignals.includes(s.key),
      }));

    return NextResponse.json({
      asset: {
        assetId: asset.assetId,
        type: asset.type,
        system: asset.system,
        name: asset.name,
        vendor: asset.vendor,
        model: asset.model,
        location: {
          siteName: asset.siteName,
          buildingName: asset.buildingName,
          zoneId: asset.zoneId,
          zoneName: asset.zoneName,
          level: asset.level,
        },
        specs: asset.specs,
        points,
        additiveSignals: additive,
        maintenance: asset.maintenance ?? null,
      },
      measurement,
      enabledSignals,
      staleAfterMs: TELEMETRY.staleAfterMs,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
