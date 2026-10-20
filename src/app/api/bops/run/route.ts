// Run lifecycle + simulator control.
//   POST { action: "create" | "start" | "pause" | "inject_fault" | "recover"
//                 | "enable_signal" | "reset", runId?, token?, assetId?, signalKey? }
// Reset retires the previous worker and returns a brand-new run (the UI then
// switches to it — isolation is immediate at the UI level; old data expires via
// TTL asynchronously).
import { NextRequest, NextResponse } from "next/server";
import { createRun, authorizeRun, updateRun, enableSignal } from "@/lib/bops/runs";
import {
  startWorker,
  stopWorker,
  injectFault,
  recover,
  seedHistory,
} from "@/lib/bops/worker";
import { SIGNALS, FAULT_TARGET_ASSET_ID } from "@/lib/bops/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    // create / reset do not require an existing token.
    if (action === "create" || action === "reset") {
      if (action === "reset" && body.runId) {
        // Best-effort retire the old worker (ownership checked if token given).
        stopWorker(String(body.runId));
      }
      const run = await createRun(body.label ? String(body.label) : undefined);
      await updateRun(run.runId, { simulatorStatus: "running" });
      const seeded = await seedHistory(run.runId);
      await startWorker(run.runId);
      return NextResponse.json({
        runId: run.runId,
        token: run.ownerToken,
        seededReadings: seeded,
        simulatorStatus: "running",
      });
    }

    // All other actions require run ownership (server-validated).
    const run = await authorizeRun(body.runId, body.token);
    if (!run) {
      return NextResponse.json(
        { error: "unauthorized: runId/token mismatch" },
        { status: 403 }
      );
    }

    switch (action) {
      case "start":
        await updateRun(run.runId, { simulatorStatus: "running" });
        await startWorker(run.runId);
        return NextResponse.json({ ok: true, simulatorStatus: "running" });
      case "pause":
        await updateRun(run.runId, { simulatorStatus: "paused" });
        return NextResponse.json({ ok: true, simulatorStatus: "paused" });
      case "inject_fault":
        await updateRun(run.runId, { faultActive: true });
        await startWorker(run.runId);
        await injectFault(run.runId);
        return NextResponse.json({ ok: true, faultActive: true });
      case "recover":
        await updateRun(run.runId, { faultActive: false });
        recover(run.runId);
        return NextResponse.json({ ok: true, faultActive: false });
      case "enable_signal": {
        const assetId = String(body.assetId || FAULT_TARGET_ASSET_ID);
        const signalKey = String(body.signalKey || SIGNALS.differentialPressureKpa.key);
        if (!(signalKey in SIGNALS)) {
          return NextResponse.json({ error: "unknown signal" }, { status: 400 });
        }
        await enableSignal(run.runId, assetId, signalKey);
        return NextResponse.json({ ok: true, assetId, signalKey });
      }
      default:
        return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
