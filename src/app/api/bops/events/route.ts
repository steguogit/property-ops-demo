// Recent event feed for a run, with severity / zone / system / event-type
// filters. Events use event-time ordering (newest first).
import { NextRequest, NextResponse } from "next/server";
import { eventsCol } from "@/lib/bops/mongo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const runId = q.get("runId") || "";
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const filter: Record<string, unknown> = { runId };
  const severity = q.get("severity");
  const zoneId = q.get("zoneId");
  const system = q.get("system");
  const eventType = q.get("eventType");
  if (severity) filter.severity = severity;
  if (zoneId) filter.zoneId = zoneId;
  if (system) filter.system = system;
  if (eventType) filter.eventType = eventType;

  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);

  try {
    const col = await eventsCol();
    const rows = await col.find(filter).sort({ eventTime: -1 }).limit(limit).toArray();
    return NextResponse.json({
      events: rows.map((e) => ({
        eventId: e.eventId,
        eventTime: e.eventTime,
        deviceId: e.deviceId,
        zoneId: e.zoneId,
        system: e.system,
        eventType: e.eventType,
        severity: e.severity,
        details: e.details,
        simulated: e.simulated,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
