// =============================================================================
// Deterministic building telemetry simulator.
//
// Pure, seeded generation so tests are reproducible. The simulator produces
// synthetic readings for the mechanical assets and a single independent
// door/access event during the chiller scenario. It NEVER creates incidents —
// detection is a separate backend aggregation over persisted telemetry.
//
// Time is aligned to real UTC. No acceleration.
// =============================================================================
import {
  NORMAL_SETPOINTS,
  TELEMETRY_ASSET_IDS,
  ASSET_SEEDS,
  SIGNALS,
  SignalKey,
  FAULT_TARGET_ASSET_ID,
  ZONES,
  SITE,
} from "./config";
import type { TelemetryReading, EventDoc } from "./mongo";

// ---- Seeded PRNG (mulberry32) — deterministic per (runId, assetId, tick) ----
function hashStr(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Deterministic gaussian-ish noise in [-1,1] from a seed string. */
function noise(seed: string): number {
  const r = mulberry32(hashStr(seed));
  return (r() + r() + r() - 1.5) / 1.5; // sum of 3 uniforms, centered
}

export interface FaultState {
  /** Epoch ms when the fault was injected, or null if not active. */
  faultStartMs: number | null;
  /** Epoch ms when recovery began, or null. */
  recoveryStartMs: number | null;
}

export const NO_FAULT: FaultState = { faultStartMs: null, recoveryStartMs: null };

/**
 * Fault progression factor in [0,1]. Ramps from 0 to 1 over `rampSeconds`
 * after injection, holds at 1, then ramps back to 0 over `recoverSeconds`
 * after recovery is triggered. Deterministic function of time only.
 */
export function faultProgress(
  nowMs: number,
  fault: FaultState,
  rampSeconds = 45,
  recoverSeconds = 40
): number {
  if (fault.faultStartMs == null) return 0;
  const rampUp = Math.min(1, Math.max(0, (nowMs - fault.faultStartMs) / (rampSeconds * 1000)));
  if (fault.recoveryStartMs == null) return rampUp;
  const held = rampUp; // value reached when recovery began (≈1 if held long enough)
  const recoverFrac = Math.min(
    1,
    Math.max(0, (nowMs - fault.recoveryStartMs) / (recoverSeconds * 1000))
  );
  return held * (1 - recoverFrac);
}

/** Fault deltas applied to the chiller at full progression (p=1). */
const FAULT_FULL_DELTA: Partial<Record<SignalKey, number>> = {
  leavingChilledWaterTempC: 3.2, // °C rise — crosses the 1.6°C rule
  compressorVibrationMmS: 3.1, // mm/s rise
  electricalInputPowerKw: 42, // kW rise (plausible extra draw)
  differentialPressureKpa: 28, // kPa rise (only visible if additive enabled)
};

/**
 * Generate one reading for one asset at a timestamp. Deterministic given
 * (runId, assetId, tsMs, fault, enabledSignals).
 */
export function generateReading(
  runId: string,
  assetId: string,
  tsMs: number,
  fault: FaultState,
  enabledSignals: string[] = []
): TelemetryReading {
  const seed = ASSET_SEEDS.find((a) => a.assetId === assetId)!;
  const setpoints = NORMAL_SETPOINTS[assetId] ?? {};
  const p = assetId === FAULT_TARGET_ASSET_ID ? faultProgress(tsMs, fault) : 0;
  const faultActive = fault.faultStartMs != null && p > 0.001;

  const reading: TelemetryReading = {
    ts: new Date(tsMs),
    meta: {
      runId,
      siteId: SITE.siteId,
      buildingId: SITE.buildingId,
      zoneId: seed.zoneId,
      assetId,
      system: seed.system,
    },
    quality: "good",
    faultActive,
  };

  // Slow diurnal drift so charts are not flat (deterministic, small).
  const drift = Math.sin(tsMs / (1000 * 60 * 7)) * 0.15;

  for (const point of seed.points) {
    const key = point.key as SignalKey;
    const base = setpoints[key];
    if (base == null) continue;
    const n = noise(`${runId}|${assetId}|${key}|${Math.floor(tsMs / 1000)}`);
    const amp = baseNoiseAmp(key, base);
    const faultDelta = (FAULT_FULL_DELTA[key] ?? 0) * p;
    (reading as any)[key] = round(base + base * drift * 0.02 + n * amp + faultDelta, key);
  }

  // Additive signal: only written once enabled for this run+asset.
  if (
    assetId === FAULT_TARGET_ASSET_ID &&
    enabledSignals.includes(SIGNALS.differentialPressureKpa.key)
  ) {
    const key = SIGNALS.differentialPressureKpa.key as SignalKey;
    const base = setpoints[key] ?? 185;
    const n = noise(`${runId}|${assetId}|${key}|${Math.floor(tsMs / 1000)}`);
    const faultDelta = (FAULT_FULL_DELTA[key] ?? 0) * p;
    (reading as any)[key] = round(base + n * 2.5 + faultDelta, key);
  }

  return reading;
}

function baseNoiseAmp(key: SignalKey, base: number): number {
  switch (key) {
    case "leavingChilledWaterTempC":
      return 0.12;
    case "compressorVibrationMmS":
      return 0.18;
    case "electricalInputPowerKw":
      return base * 0.012;
    case "supplyAirTempC":
      return 0.15;
    case "flowRateLps":
      return 0.4;
    case "differentialPressureKpa":
      return 2.5;
    default:
      return base * 0.01;
  }
}

function round(v: number, key: SignalKey): number {
  const decimals =
    key === "electricalInputPowerKw" || key === "differentialPressureKpa" ? 1 : 2;
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/**
 * Generate a full batch of readings for all telemetry assets at a timestamp.
 */
export function generateTick(
  runId: string,
  tsMs: number,
  fault: FaultState,
  enabledByAsset: Record<string, string[]> = {}
): TelemetryReading[] {
  return TELEMETRY_ASSET_IDS.map((assetId) =>
    generateReading(runId, assetId, tsMs, fault, enabledByAsset[assetId] ?? [])
  );
}

/**
 * Pre-seed normal history: readings at a fixed cadence ending just before now,
 * with NO fault. Returns readings in chronological order.
 */
export function generateHistory(
  runId: string,
  endMs: number,
  minutes: number,
  intervalMs: number,
  enabledByAsset: Record<string, string[]> = {}
): TelemetryReading[] {
  const out: TelemetryReading[] = [];
  const count = Math.floor((minutes * 60 * 1000) / intervalMs);
  const startMs = endMs - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const tsMs = startMs + i * intervalMs;
    out.push(...generateTick(runId, tsMs, NO_FAULT, enabledByAsset));
  }
  return out;
}

/**
 * The independent synthetic door/access event emitted in the plant-room zone
 * during the chiller scenario. CONTEXT only — not a cause.
 */
export function buildScenarioDoorEvent(runId: string, eventTimeMs: number): EventDoc {
  const eid = `EVT-${runId}-door-${eventTimeMs}`;
  return {
    eventId: eid,
    runId,
    eventTime: new Date(eventTimeMs),
    deviceId: "DOOR-B2-01",
    siteId: SITE.siteId,
    buildingId: SITE.buildingId,
    zoneId: ZONES.plantRoom.zoneId,
    system: "security",
    eventType: "door_held_open",
    severity: "low",
    details: {
      durationSeconds: 95,
      contactState: "open",
      note: "Plant-room door held open (synthetic). Contextual match only.",
    },
    simulated: true,
    createdAt: new Date(),
  };
}

/** A routine access-granted event for ambient realism (non-plant zone). */
export function buildAmbientAccessEvent(runId: string, eventTimeMs: number): EventDoc {
  const eid = `EVT-${runId}-acc-${eventTimeMs}`;
  return {
    eventId: eid,
    runId,
    eventTime: new Date(eventTimeMs),
    deviceId: "ACCESS-B2-01",
    siteId: SITE.siteId,
    buildingId: SITE.buildingId,
    zoneId: ZONES.plantRoom.zoneId,
    system: "security",
    eventType: "access_granted",
    severity: "info",
    details: { readerId: "RDR-B2-01", method: "card", note: "Routine access (synthetic)." },
    simulated: true,
    createdAt: new Date(),
  };
}
