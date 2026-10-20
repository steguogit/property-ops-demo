// =============================================================================
// Simulator worker manager — a single in-process interval per run.
//
// Held on globalThis so Next.js hot-reload / repeated route invocations reuse
// the same worker (never duplicate workers for a run). Each tick:
//   1. reload run config (enabled signals, fault/pause state),
//   2. generate + persist one telemetry reading per mechanical asset,
//   3. run the real backend anomaly detector (which reads persisted telemetry).
//
// Pausing stops new measurements (data then goes stale). Stopping clears the
// interval. The chiller scenario schedules its ramp + the independent door
// event here; detection still happens only via the detector over persisted data.
// =============================================================================
import { TELEMETRY, FAULT_TARGET_ASSET_ID } from "./config";
import { telemetryCol, eventsCol } from "./mongo";
import { getRun } from "./runs";
import {
  generateTick,
  generateHistory,
  buildScenarioDoorEvent,
  buildAmbientAccessEvent,
  NO_FAULT,
  FaultState,
} from "./simulator";
import { evaluateAndPersist } from "./anomaly";

interface Worker {
  runId: string;
  timer: NodeJS.Timeout;
  fault: FaultState;
  doorEventScheduledAt: number | null;
  doorEventEmitted: boolean;
  lastTickMs: number;
}

interface WorkerRegistry {
  workers: Map<string, Worker>;
}

declare global {
  // eslint-disable-next-line no-var
  var __bopsWorkers: WorkerRegistry | undefined;
}

function registry(): WorkerRegistry {
  if (!globalThis.__bopsWorkers) globalThis.__bopsWorkers = { workers: new Map() };
  return globalThis.__bopsWorkers;
}

/** Seed ~15 min of normal history for a run (idempotent-ish: cadence-aligned). */
export async function seedHistory(runId: string): Promise<number> {
  const col = await telemetryCol();
  const nowMs = alignToInterval(Date.now());
  const readings = generateHistory(
    runId,
    nowMs,
    TELEMETRY.seedHistoryMinutes,
    TELEMETRY.intervalMs
  );
  if (!readings.length) return 0;
  await col.insertMany(readings, { ordered: false });
  return readings.length;
}

function alignToInterval(ms: number): number {
  return Math.floor(ms / TELEMETRY.intervalMs) * TELEMETRY.intervalMs;
}

export function workerStatus(runId: string): "running" | "stopped" {
  return registry().workers.has(runId) ? "running" : "stopped";
}

/** Start (or resume) the live worker for a run. No-op if already running. */
export async function startWorker(runId: string): Promise<void> {
  const reg = registry();
  if (reg.workers.has(runId)) return; // never duplicate
  const run = await getRun(runId);
  const worker: Worker = {
    runId,
    timer: null as any,
    fault: run?.faultActive ? { faultStartMs: Date.now(), recoveryStartMs: null } : NO_FAULT,
    doorEventScheduledAt: null,
    doorEventEmitted: false,
    lastTickMs: 0,
  };
  worker.timer = setInterval(() => void tick(worker), TELEMETRY.intervalMs);
  // Prevent the timer from keeping the process alive unnecessarily in scripts.
  if (typeof worker.timer.unref === "function") worker.timer.unref();
  reg.workers.set(runId, worker);
  // Fire one immediate tick so data appears promptly.
  void tick(worker);
}

export function stopWorker(runId: string): void {
  const reg = registry();
  const w = reg.workers.get(runId);
  if (w) {
    clearInterval(w.timer);
    reg.workers.delete(runId);
  }
}

/** Inject the chiller fault scenario: ramp + schedule the independent door event. */
export async function injectFault(runId: string): Promise<void> {
  const w = registry().workers.get(runId);
  const now = Date.now();
  if (w) {
    w.fault = { faultStartMs: now, recoveryStartMs: null };
    // Independent door/access event ~25s into the scenario (within correlation
    // window of the ~30–60s detection), in the plant-room zone.
    w.doorEventScheduledAt = now + 25000;
    w.doorEventEmitted = false;
  }
  // Also emit a routine ambient access event now (non-correlating severity).
  const evCol = await eventsCol();
  await evCol
    .insertOne(buildAmbientAccessEvent(runId, now) as any)
    .catch(() => {});
}

/** Trigger simulated recovery: equipment measurements ramp back to normal. */
export function recover(runId: string): void {
  const w = registry().workers.get(runId);
  if (w && w.fault.faultStartMs != null && w.fault.recoveryStartMs == null) {
    w.fault.recoveryStartMs = Date.now();
  }
}

async function tick(worker: Worker): Promise<void> {
  try {
    const run = await getRun(worker.runId);
    if (!run) {
      stopWorker(worker.runId);
      return;
    }
    if (run.simulatorStatus === "paused") return; // stop producing — data goes stale

    const tsMs = alignToInterval(Date.now());
    if (tsMs === worker.lastTickMs) return; // avoid duplicate timestamps
    worker.lastTickMs = tsMs;

    const col = await telemetryCol();
    const readings = generateTick(worker.runId, tsMs, worker.fault, run.enabledSignals);
    await col.insertMany(readings, { ordered: false }).catch(() => {});

    // Emit the scheduled independent door event once.
    if (
      worker.doorEventScheduledAt != null &&
      !worker.doorEventEmitted &&
      Date.now() >= worker.doorEventScheduledAt
    ) {
      worker.doorEventEmitted = true;
      const evCol = await eventsCol();
      await evCol
        .insertOne(buildScenarioDoorEvent(worker.runId, worker.doorEventScheduledAt) as any)
        .catch(() => {});
    }

    // Run the real backend detector over persisted telemetry for the chiller.
    await evaluateAndPersist(worker.runId, FAULT_TARGET_ASSET_ID).catch(() => {});
  } catch {
    /* best-effort tick; next interval retries */
  }
}

/** Whether the scenario fault is active in-memory for a run (UI hint). */
export function faultActiveInMemory(runId: string): boolean {
  const w = registry().workers.get(runId);
  return !!w && w.fault.faultStartMs != null && w.fault.recoveryStartMs == null;
}
