// =============================================================================
// Demo-run lifecycle & server-side session isolation.
//
// Every run has a server-generated runId + ownerToken. API calls that mutate a
// run (control the simulator, enable measurements, reset) must present a token
// that matches the stored run — a client-supplied runId alone is NOT sufficient
// isolation. Read endpoints are scoped by runId.
// =============================================================================
import { randomBytes } from "crypto";
import { runsCol } from "./mongo";
import type { RunDoc } from "./mongo";

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export async function createRun(label?: string): Promise<RunDoc> {
  const now = new Date();
  const run: RunDoc = {
    runId: newId("RUN"),
    createdAt: now,
    enabledSignals: {},
    simulatorStatus: "stopped",
    faultActive: false,
    ownerToken: randomBytes(16).toString("hex"),
    label,
    updatedAt: now,
  };
  const col = await runsCol();
  await col.insertOne({ _id: run.runId, ...run } as any);
  return run;
}

export async function getRun(runId: string): Promise<RunDoc | null> {
  const col = await runsCol();
  return col.findOne({ runId });
}

/** Validate ownership: runId + matching ownerToken. Returns the run or null. */
export async function authorizeRun(
  runId: string | undefined,
  token: string | undefined
): Promise<RunDoc | null> {
  if (!runId || !token) return null;
  const run = await getRun(runId);
  if (!run || run.ownerToken !== token) return null;
  return run;
}

export async function updateRun(
  runId: string,
  patch: Partial<RunDoc>
): Promise<void> {
  const col = await runsCol();
  await col.updateOne({ runId }, { $set: { ...patch, updatedAt: new Date() } });
}

export async function enableSignal(
  runId: string,
  assetId: string,
  signalKey: string
): Promise<void> {
  const col = await runsCol();
  await col.updateOne(
    { runId },
    {
      $addToSet: { [`enabledSignals.${assetId}`]: signalKey } as any,
      $set: { updatedAt: new Date() },
    }
  );
}
