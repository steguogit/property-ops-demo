// Operator actions on an incident. Requires run ownership (server-validated).
//   POST { runId, token, incidentId, action, note?, workOrder? }
//   action: acknowledge | resolve | dismiss | create_work_order
//
// IMPORTANT separation of concerns:
//   * Acknowledging / resolving / dismissing changes WORKFLOW status only. It
//     does NOT imply measurements recovered. Measured equipment condition is
//     driven solely by telemetry + the detector.
//   * A work order is a DEMO-ONLY draft; it is never submitted anywhere.
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { authorizeRun } from "@/lib/bops/runs";
import { incidentsCol } from "@/lib/bops/mongo";
import type { OperatorAction, WorkOrderDraft, IncidentStatus } from "@/lib/bops/mongo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPERATOR = "operator@demo";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const run = await authorizeRun(body.runId, body.token);
  if (!run) {
    return NextResponse.json({ error: "unauthorized: runId/token mismatch" }, { status: 403 });
  }
  const incidentId = String(body.incidentId || "");
  const action = String(body.action || "");
  if (!incidentId || !action) {
    return NextResponse.json({ error: "incidentId and action required" }, { status: 400 });
  }

  try {
    const col = await incidentsCol();
    const inc = await col.findOne({ incidentId, runId: run.runId });
    if (!inc) return NextResponse.json({ error: "incident not found" }, { status: 404 });

    const now = new Date().toISOString();
    const note = body.note ? String(body.note).slice(0, 1000) : undefined;

    if (action === "create_work_order") {
      const selectedEventIds: string[] = Array.isArray(body.relatedEventIds)
        ? body.relatedEventIds.map((s: any) => String(s))
        : [];
      const knowledgeRefs = Array.isArray(body.knowledgeRefs)
        ? body.knowledgeRefs.slice(0, 20).map((k: any) => ({
            docId: String(k.docId),
            title: String(k.title ?? ""),
            revision: k.revision ? String(k.revision) : undefined,
            source: k.source ? String(k.source) : undefined,
          }))
        : [];
      const draft: WorkOrderDraft = {
        workOrderId: `WO-${run.runId}-${randomBytes(3).toString("hex")}`,
        incidentId,
        assetId: inc.assetId,
        note: note ?? "",
        evidenceSnapshot: inc.evidence, // source evidence (distinct from note)
        telemetryIntervalRef: {
          start: inc.evidence.telemetryIntervalStart,
          end: inc.evidence.telemetryIntervalEnd,
        },
        relatedEventIds: inc.relatedEvents
          .filter((r) => selectedEventIds.includes(r.eventId))
          .map((r) => r.eventId),
        knowledgeRefs,
        status: "draft",
        createdAt: now,
        updatedAt: now,
        demoOnly: true,
      };
      const act: OperatorAction = {
        action: "create_work_order",
        at: now,
        by: OPERATOR,
        note: `Created work-order draft ${draft.workOrderId}`,
      };
      await col.updateOne(
        { incidentId },
        { $set: { workOrder: draft, updatedAt: new Date() }, $push: { actions: act } }
      );
      return NextResponse.json({ ok: true, workOrder: draft });
    }

    // Status-change actions (workflow only — not equipment recovery).
    const statusMap: Record<string, IncidentStatus> = {
      acknowledge: "acknowledged",
      resolve: "resolved",
      dismiss: "dismissed",
    };
    const newStatus = statusMap[action];
    if (!newStatus) {
      return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
    }
    const act: OperatorAction = {
      action: action as OperatorAction["action"],
      at: now,
      by: OPERATOR,
      note,
    };
    await col.updateOne(
      { incidentId },
      { $set: { status: newStatus, updatedAt: new Date() }, $push: { actions: act } }
    );
    return NextResponse.json({ ok: true, status: newStatus });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
