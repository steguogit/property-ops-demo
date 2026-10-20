// Dashboard overview for a run: building context, asset cards (latest values +
// data quality/staleness), summary (active incidents, assets reporting,
// monitored equipment power, simulator/feed status).
import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/bops/runs";
import { workerStatus, faultActiveInMemory } from "@/lib/bops/worker";
import { latestByAsset, monitoredEquipmentPowerKw } from "@/lib/bops/telemetry";
import { assetsCol, incidentsCol } from "@/lib/bops/mongo";
import { TELEMETRY, SITE, NORMAL_SETPOINTS, ANOMALY_RULE } from "@/lib/bops/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId") || "";
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  try {
    const run = await getRun(runId);
    const simulatorStatus = run?.simulatorStatus ?? "stopped";
    const workerLive = workerStatus(runId);

    const [assets, latest, power, openIncidents] = await Promise.all([
      (await assetsCol()).find({}).toArray(),
      latestByAsset(runId),
      monitoredEquipmentPowerKw(runId),
      (await incidentsCol())
        .find({ runId, status: { $in: ["open", "acknowledged"] } })
        .sort({ detectedAt: -1 })
        .toArray(),
    ]);

    const now = Date.now();
    const cards = assets.map((a) => {
      const l = latest[a.assetId];
      const stale = l ? l.ageMs > TELEMETRY.staleAfterMs : true;
      const reporting = !!l && !stale;
      // Whether the primary signal is back within its normal band — used to
      // distinguish "measurements recovered" from "incident still open".
      const primary = ANOMALY_RULE.primarySignal as string;
      const setpoint = (NORMAL_SETPOINTS[a.assetId] as any)?.[primary];
      const cur = l?.values?.[primary];
      const measurementsNormal =
        typeof cur === "number" && typeof setpoint === "number"
          ? cur - setpoint < ANOMALY_RULE.thresholdDeltaC
          : null;
      return {
        assetId: a.assetId,
        type: a.type,
        system: a.system,
        name: a.name,
        vendor: a.vendor,
        model: a.model,
        zoneId: a.zoneId,
        zoneName: a.zoneName,
        level: a.level,
        points: a.points,
        latest: l
          ? { ts: l.ts, values: l.values, ageMs: l.ageMs }
          : null,
        reporting,
        stale,
        measurementsNormal,
        hasIncident: openIncidents.some((i) => i.assetId === a.assetId),
      };
    });

    const reportingCount = cards.filter((c) => c.reporting).length;
    const mechanicalCount = cards.filter((c) => c.points.length > 0).length;

    return NextResponse.json({
      serverTime: new Date(now).toISOString(),
      building: {
        siteId: SITE.siteId,
        siteName: SITE.siteName,
        buildingId: SITE.buildingId,
        buildingName: SITE.buildingName,
        timezone: SITE.timezone,
      },
      summary: {
        activeIncidents: openIncidents.length,
        assetsReporting: reportingCount,
        assetsTotalMechanical: mechanicalCount,
        monitoredEquipmentPowerKw: power.totalKw,
        powerReportingCount: power.reporting,
        simulatorStatus,
        workerLive: workerLive === "running",
        faultActive: faultActiveInMemory(runId),
        staleAfterMs: TELEMETRY.staleAfterMs,
      },
      assets: cards,
      incidents: openIncidents.map((i) => ({
        incidentId: i.incidentId,
        assetId: i.assetId,
        title: i.title,
        severity: i.severity,
        status: i.status,
        zoneId: i.zoneId,
        detectedAt: i.detectedAt,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, mongoConnected: false },
      { status: 500 }
    );
  }
}
