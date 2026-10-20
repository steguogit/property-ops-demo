// Incidents for a run (list or single via ?incidentId). Also refreshes
// correlation on single fetch so late-arriving contextual events appear.
import { NextRequest, NextResponse } from "next/server";
import { incidentsCol, eventsCol } from "@/lib/bops/mongo";
import { refreshCorrelation } from "@/lib/bops/anomaly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const runId = q.get("runId") || "";
  const incidentId = q.get("incidentId");
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  try {
    const col = await incidentsCol();
    if (incidentId) {
      // Refresh correlation through the query/update path (late events).
      await refreshCorrelation(incidentId);
      const inc = await col.findOne({ incidentId, runId });
      if (!inc) return NextResponse.json({ error: "not found" }, { status: 404 });
      // Attach full event detail for the related (contextual) events.
      const evCol = await eventsCol();
      const ids = inc.relatedEvents.map((r) => r.eventId);
      const evs = ids.length
        ? await evCol.find({ eventId: { $in: ids } }).toArray()
        : [];
      const evById = new Map(evs.map((e) => [e.eventId, e]));
      return NextResponse.json({
        incident: {
          ...inc,
          relatedEvents: inc.relatedEvents.map((r) => ({
            ...r,
            details: evById.get(r.eventId)?.details ?? null,
            deviceId: evById.get(r.eventId)?.deviceId ?? null,
          })),
        },
      });
    }
    const rows = await col.find({ runId }).sort({ detectedAt: -1 }).toArray();
    return NextResponse.json({ incidents: rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
