// Mongo accessors + document types for the Building Operations Control Room.
// Reuses the shared client/db from src/lib/mongo.ts (single pooled connection).
import { Collection } from "mongodb";
import { getDb } from "../mongo";
import { BOPS, AssetType, SystemName } from "./config";

// ---------------------------------------------------------------------------
// telemetry — native time-series collection.
// One reading document holds the supported metrics for an asset at a timestamp.
// `meta` is STABLE metadata only (identity). Changing values (measurements,
// health, incident status) live outside meta. `runId` is constant for a run.
// ---------------------------------------------------------------------------
export interface TelemetryReading {
  ts: Date; // BSON Date — timeField
  meta: {
    runId: string;
    siteId: string;
    buildingId: string;
    zoneId: string;
    assetId: string;
    system: SystemName;
  };
  // numeric measurement fields (sparse — only what the asset reports) ---------
  leavingChilledWaterTempC?: number;
  compressorVibrationMmS?: number;
  electricalInputPowerKw?: number;
  differentialPressureKpa?: number; // additive — absent before activation
  flowRateLps?: number;
  supplyAirTempC?: number;
  // measurement-quality fields (outside stable metadata) ----------------------
  quality?: "good" | "degraded" | "stale";
  /** True when this reading was produced while the fault scenario was active
   *  (label only; does NOT drive detection). */
  faultActive?: boolean;
}

export interface AssetDoc {
  _id?: string; // = assetId
  assetId: string;
  type: AssetType;
  system: SystemName;
  name: string;
  vendor: string;
  model: string;
  siteId: string;
  siteName: string;
  buildingId: string;
  buildingName: string;
  zoneId: string;
  zoneName: string;
  level: string;
  specs: Record<string, unknown>;
  points: { key: string; label: string; unit: string; additive?: boolean }[];
  maintenance?: { lastServiced?: string; intervalDays?: number; note?: string };
  updatedAt: string;
}

export type EventType =
  | "door_held_open"
  | "access_denied"
  | "device_health"
  | "access_granted";
export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface EventDoc {
  _id?: string; // = eventId
  eventId: string;
  runId: string;
  eventTime: Date; // BSON Date — correlation uses THIS, not ingestion time
  deviceId: string; // asset/device that emitted the event
  siteId: string;
  buildingId: string;
  zoneId: string;
  system: SystemName;
  eventType: EventType;
  severity: Severity;
  /** Type-specific details. No personal identity, images, or video. */
  details: Record<string, unknown>;
  simulated: true;
  createdAt: Date; // ingestion time
}

export type IncidentStatus = "open" | "acknowledged" | "resolved" | "dismissed";

export interface DetectionEvidence {
  ruleId: string;
  ruleVersion: string;
  ruleName: string;
  primarySignal: string;
  primaryUnit: string;
  observedValue: number;
  baselineMean: number;
  baselineWindowSeconds: number;
  thresholdDeltaC: number;
  deltaOverBaseline: number;
  validSampleCount: number;
  consecutiveBreaches: number;
  detectionTime: string; // ISO
  telemetryIntervalStart: string; // ISO
  telemetryIntervalEnd: string; // ISO
  /** Supporting signal snapshot at detection. */
  supporting: { key: string; label: string; unit: string; value: number }[];
}

export interface OperatorAction {
  action: "acknowledge" | "resolve" | "dismiss" | "create_work_order" | "reopen";
  at: string; // ISO
  by: string; // operator label (demo)
  note?: string;
}

export interface WorkOrderDraft {
  workOrderId: string;
  incidentId: string;
  assetId: string;
  note: string; // operator interpretation (distinct from evidence)
  evidenceSnapshot: DetectionEvidence; // source evidence
  telemetryIntervalRef: { start: string; end: string };
  relatedEventIds: string[];
  knowledgeRefs: { docId: string; title: string; revision?: string; source?: string }[];
  status: "draft";
  createdAt: string;
  updatedAt: string;
  /** Always demo-only — never submitted anywhere. */
  demoOnly: true;
}

export interface CorrelatedEventRef {
  eventId: string;
  eventType: EventType;
  eventTime: string; // ISO
  zoneId: string;
  severity: Severity;
  /** Signed seconds from detection (negative = before). */
  offsetSeconds: number;
}

export interface IncidentDoc {
  _id?: string; // = incidentId
  incidentId: string;
  runId: string;
  assetId: string;
  siteId: string;
  buildingId: string;
  zoneId: string;
  ruleId: string;
  ruleVersion: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  evidence: DetectionEvidence;
  /** Refreshed through the query/update path so late-arriving events appear. */
  relatedEvents: CorrelatedEventRef[];
  actions: OperatorAction[]; // bounded operator-action history
  workOrder?: WorkOrderDraft; // optional embedded draft
  detectedAt: Date;
  updatedAt: Date;
}

export type KnowledgeDocType =
  | "maintenance_procedure"
  | "service_note"
  | "historical_incident";

export interface KnowledgeDoc {
  _id?: string; // = docId
  docId: string;
  docType: KnowledgeDocType;
  title: string;
  /** chunkText is the field Atlas auto-embeds (voyage-4) AND the lexical index
   *  searches. Keep the searchable prose here. */
  chunkText: string;
  equipmentType: AssetType | "general";
  model?: string;
  source: string;
  revision: string;
  docDate: string; // ISO date
  /** Optional references. */
  assetRef?: string;
  timeRangeRef?: { start: string; end: string };
  /** Type-specific nested content. */
  procedure?: { steps: string[] };
  history?: { symptoms: string; investigation: string; outcome: string };
  /** Provenance of the embedding approach (documented, not a vector here —
   *  Atlas auto-embeds chunkText server-side). */
  embeddingProvenance: {
    strategy: "atlas_auto_embed";
    model: string; // voyage-4
    field: "chunkText";
  };
  updatedAt: string;
}

/** Small per-run config record (session isolation + additive-measurement flag). */
export interface RunDoc {
  _id?: string; // = runId
  runId: string;
  createdAt: Date;
  /** Which additive signals are enabled for this run, per asset. */
  enabledSignals: Record<string, string[]>; // assetId -> [signalKey]
  /** Simulator lifecycle status for this run. */
  simulatorStatus: "running" | "paused" | "stopped";
  /** Whether the fault scenario is currently injected. */
  faultActive: boolean;
  /** Owner token (server-validated) — a client runId alone is not sufficient. */
  ownerToken: string;
  label?: string;
  updatedAt: Date;
}

export async function telemetryCol(): Promise<Collection<TelemetryReading>> {
  return (await getDb()).collection<TelemetryReading>(BOPS.telemetry);
}
export async function assetsCol(): Promise<Collection<AssetDoc>> {
  return (await getDb()).collection<AssetDoc>(BOPS.assets);
}
export async function eventsCol(): Promise<Collection<EventDoc>> {
  return (await getDb()).collection<EventDoc>(BOPS.events);
}
export async function incidentsCol(): Promise<Collection<IncidentDoc>> {
  return (await getDb()).collection<IncidentDoc>(BOPS.incidents);
}
export async function knowledgeCol(): Promise<Collection<KnowledgeDoc>> {
  return (await getDb()).collection<KnowledgeDoc>(BOPS.knowledge);
}
export async function runsCol(): Promise<Collection<RunDoc>> {
  return (await getDb()).collection<RunDoc>(BOPS.runs);
}
