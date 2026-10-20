# Building Operations Control Room

A desktop-first operator demo for a property company running commercial buildings
with mixed-vendor equipment. It demonstrates, in one coherent workflow, how
MongoDB stores continuous measurements in a **native time-series collection**,
represents **heterogeneous equipment and events** as flexible documents, supports
**investigation** with **Atlas Search** and **Vector Search**, and **persists the
operational decision**.

Route: **`/control-room`** (the existing retrieval demo at `/` is untouched).

---

## 1. Business scenario & 5-minute presenter script

The primary user is a **facilities operator**. Security-device events provide
**supporting context** — this is not a security-operations product.

1. **Normal.** Open `/control-room`. A building ("Harbourgate Commercial Tower →
   Tower A") is operating normally. Three mechanical assets (chiller, pump, AHU)
   stream clearly-labeled **synthetic** telemetry into MongoDB; two security
   devices (door contact, access panel) are event-based. The state is calm.
   *(~15 minutes of normal history is pre-seeded so charts and baselines are
   ready immediately.)*
2. **Inject the fault.** Click **⚡ Run chiller scenario**. Leaving chilled-water
   temperature, compressor vibration, and electrical input power begin to rise on
   `CHILLER-01`.
3. **Backend detection.** Within ~30–60 s the **backend** rolling-window rule
   (not the UI, not the fault button) creates an **incident** from persisted
   telemetry. The chiller card and its zone turn red.
4. **Context event.** An independent **door-held-open** event is emitted in the
   same plant-room zone/time window and appears in the event feed.
5. **Investigate.** Click the chiller → review current measurements + data
   quality, raw & 1-minute aggregated charts, and the **detection evidence**
   (observed value, baseline/window, threshold, valid sample count, timestamps,
   supporting signals). The door event shows under **Related events** labeled as
   a **contextual match** (correlation ≠ causation).
 6. **Knowledge.** Switch to the **Knowledge** tab.
   - *Keyword Search* (`chiller vibration`, filter equipment = chiller) → Atlas
     Search returns the vibration procedure with highlights. **Facet chips** with
     live counts (from `$searchMeta`) let you narrow by equipment / document type
     with one click.
   - *Similar reported symptoms* (Vector) with the preset symptom query → Vector
     Search retrieves a **differently-worded 2024 historical case**.
   - **View original document** on any hit opens the live stored MongoDB document
     (same idea as the root demo's sample-doc view).
 7. **Enable additional measurement.** Click **＋ Enable differential pressure**.
   New readings gain a `differentialPressureKpa` series; historical readings stay
   **unavailable** (not zero).
 8. **Create work order.** Attach a knowledge doc + the related event, add an
   operator note, and **Create work-order draft**. It persists (labeled
   *Demo-only — not submitted*). **Where to see it:** it lives inside the
   incident — a banner appears at the top of the Incident section and the full
   draft (id, status, evidence snapshot, linked events + knowledge refs) renders
   under "Create simulated work order". There is no separate work-order list; the
   draft is embedded in the incident document.
 9. **Recover / reset.** **✔ Recover equipment** ramps *measurements* back to
   normal. **The incident does NOT auto-close** — equipment condition and
   operator workflow are tracked separately (acknowledgment ≠ recovery). While
   measurements are normal but the incident is still open, the asset card turns
   **amber** ("measurements normal · incident awaits resolve/dismiss") and the
   detail panel shows a guidance banner. Click **Resolve** or **Dismiss** to
   close the incident — only then does the card turn **green**.
   **⟲ Reset / replay** starts a fresh isolated run.

Open **Under the hood** at any time to see the real collection config, indexes,
and the actual aggregation pipelines.

---

## 2. Architecture & data flow

```
Deterministic simulator (seeded)        ──> bops_telemetry (native time-series)
  (src/lib/bops/simulator.ts)                  ↑ 5s cadence, UTC timestamps
  in-process worker per run                    │
  (src/lib/bops/worker.ts) ───────────────────┘
        │  each tick also runs:
        ▼
Rolling-window detector ($setWindowFields)  reads bops_telemetry
  (src/lib/bops/anomaly.ts) ──> bops_incidents  (+ correlates bops_events)

Security events (door/access) ──> bops_events

Operator (browser /control-room)
  ─ polls ─> /api/bops/overview | telemetry | events | incidents
  ─ acts ──> /api/bops/run (control) | incident-action (ack/resolve/work order)
  ─ searches ─> /api/bops/knowledge ─> Atlas Search ($search) + Vector Search
                                       ($vectorSearch, auto-embed) over bops_knowledge
```

All sources marked "synthetic" are generated locally; **storage, windowing,
chart aggregation, search, vector search, and persisted actions are real
MongoDB**.

Files:
- `src/lib/bops/` — `config.ts` (model/thresholds), `mongo.ts` (collections +
  types), `simulator.ts`, `worker.ts`, `anomaly.ts`, `telemetry.ts`,
  `knowledge.ts`, `runs.ts`, `client.ts`.
- `src/app/api/bops/` — `run`, `overview`, `telemetry`, `events`, `incidents`,
  `incident-action`, `asset`, `knowledge`, `under-the-hood`.
- `src/app/control-room/page.tsx`, `src/components/bops/*`.
- `scripts/bops-setup.ts`, `seed/bops_knowledge.json`, `tests/bops.test.ts`.

---

## 3. Collections, options & indexes

| Collection | Type | Notes |
| --- | --- | --- |
| `bops_telemetry` | **native time-series** | `timeField: ts`, `metaField: meta`, `granularity: seconds`, `expireAfterSeconds: 86400`. `meta` is **stable identity only** (runId, site, building, zone, asset, system). Measurements + quality live outside `meta`. One reading document per asset per timestamp. |
| `bops_assets` | regular | Common identity envelope + **heterogeneous nested `specs`** + `points` (labels/units). Location embedded. |
| `bops_events` | regular | Event envelope (runId, eventTime, device, building/zone, type, severity, type-specific details). No personal data. Indexes: `{runId,buildingId,zoneId,eventTime}`, unique `eventId`, TTL on `createdAt`. |
| `bops_incidents` | regular | Rule identity, detection/telemetry timestamps, small evidence snapshot, related-event refs, workflow status, bounded action history, optional embedded work-order draft. Indexes: dedup `{runId,assetId,ruleId,status}`, TTL on `detectedAt`. |
| `bops_knowledge` | regular | 16 synthetic docs (procedures, service notes, historical incidents). Searched by both `$search` and `$vectorSearch`. |
| `bops_runs` | regular | Per-run config (enabled signals, simulator status, fault flag, `ownerToken`). TTL on `createdAt`. |

All collections are **`bops_`-namespaced** so they never collide with the
existing retrieval-demo collections. Setup never drops a conflicting collection —
it reports the conflict and stops.

Search indexes on `bops_knowledge` (created by `npm run bops:setup`):
- `bops_knowledge_lexical` — **Atlas Search** mapping `title`, `chunkText`
  (string) + `equipmentType`, `docType` mapped as **both `token`** (for the
  `compound.filter` `equals` operator) **and `stringFacet`** (for the
  `$searchMeta` facet collector that powers facet-based navigation).
- `bops_knowledge_vector` — **Vector Search** with an **`autoEmbed`** field on
  `chunkText` (model `voyage-4`) + `equipmentType`/`docType` filters.

> If you created the lexical index before facets were added, rebuild it with
> `npm run bops:setup -- --recreate` (this only drops/recreates the lexical
> index; the vector index — and its embeddings — are untouched).

Extra search endpoints: `GET /api/bops/knowledge` returns live `facets` in
keyword mode; `GET /api/bops/knowledge/[docId]` returns the full stored document
for the "View original document" viewer.

Retention: telemetry TTL is **bucket-based and asynchronous** for time-series.
Reset appears instant because the UI switches to a new run — not because TTL
deletes immediately. Shared `bops_assets` and `bops_knowledge` are **never
expired**.

---

## 4. Requirements

- **MongoDB Atlas** cluster that supports **Atlas Search + Vector Search +
  Automatic Embedding** (voyage-4). Verified on **MongoDB 8.0.34 Enterprise**.
  (Native time-series requires MongoDB 5.0+; `$setWindowFields` requires 5.0+.
  Atlas Local `mongodb/mongodb-atlas-local` also works and provides Search +
  Vector Search locally.)
- Uses the repo's existing `MONGODB_URI` and `EMBEDDING_STRATEGY=atlas`
  (`ATLAS_AUTOEMBED_MODEL=voyage-4`). **No new dependencies** and **no new paid
  model dependency** — the knowledge path uses Atlas automatic embedding, so no
  client-side embedding calls are made.

### Embedding provenance

Knowledge documents are embedded by **Atlas Automatic Embedding** using the
**voyage-4** model over the `chunkText` field. Atlas embeds each document on
insert/update and embeds the **query string at search time** — so there are no
precomputed vectors to prepare and arbitrary text queries are genuinely
supported. Each seeded doc records this in `embeddingProvenance`
(`strategy: atlas_auto_embed`, `model`, `field`). Semantic retrieval is over
**written symptom prose**, not sensor waveforms.

### Search / Vector readiness checks

`GET /api/bops/knowledge` calls `searchReadiness()` first; if the required index
is not `queryable` it returns `available: false` with setup guidance (honest
unavailable state — no silent fallback). The **Under the hood** panel shows live
index status.

---

## 5. Local startup

```bash
cd property-ops-demo
npm install                 # if not already
# .env already points at the Atlas cluster (MONGODB_URI, EMBEDDING_STRATEGY=atlas)
npm run bops:setup          # idempotent: time-series + indexes + seed assets/knowledge
npm run dev                 # serves on port 3100
# open http://localhost:3100/control-room
```

`bops:setup` is safe to re-run. Atlas Search/Vector indexes take ~1–2 min to
build; the UI shows an "unavailable / building" state until ready.

> To point at a **local Atlas** instead of the cloud cluster, put a
> `MONGODB_URI=...` in `.env.local` (it overrides `.env` for both the app and the
> scripts). The cloud string stays documented in `.env`.

---

## 6. Controls

| Control | Effect |
| --- | --- |
| **▶ Start / ⏸ Pause** | Start/stop live generation. Paused → data goes **stale** (not a fake "live" state). |
| **⚡ Run chiller scenario** | Injects the gradual chiller degradation ramp + schedules the independent plant-room door event. |
| **＋ Enable differential pressure** | Additive measurement: begins writing `differentialPressureKpa` to new chiller readings; history stays unavailable. |
| **✔ Recover equipment** | Ramps measurements back to normal (workflow status unchanged). |
| **⟲ Reset / replay** | Retires the previous run's worker and creates a new isolated run; UI switches immediately. |
| **Under the hood** | Collection config, index status, retention, rule params, and the real pipelines. |

**Expected detection:** ~30–60 s after injection (4 consecutive breaching
samples). Evidence captures observed value, baseline mean + window (600 s,
excluding the most recent 5 s), threshold (Δ ≥ 1.6 °C), valid sample count,
detection/telemetry timestamps, and supporting vibration + power values.

---

## 7. Anomaly rule (understandable, not an engine)

`chiller-cooling-degradation` v1.2.0 — partitioned by `(runId, assetId)`:

1. Rolling baseline = mean of leaving chilled-water temperature over the trailing
   **600 s window, excluding the most recent 5 s** (so the gradual fault can't
   hide in an adapting mean). Computed with **`$setWindowFields`** over persisted
   telemetry.
2. A sample **breaches** when `observed − baselineMean ≥ 1.6 °C` **and** the
   baseline has **≥ 30 valid samples** (warm-up guard).
3. An incident is raised only after **4 consecutive breaches** (noise guard).
4. **Deduplicated**: one open/acknowledged incident per `(run, asset, rule)`;
   repeated polling refreshes correlation instead of creating duplicates.
5. A dismissed incident is **not immediately reopened** for the same ongoing
   episode (cooldown = baseline window).

**Correlation** is computed separately: same building + zone, within **±5 min**
of detection (event time, not ingestion time), current run only. Late-arriving
events appear on the next incident fetch (`refreshCorrelation`).

---

## 8. Session isolation & retention

Every run has a server-generated `runId` + `ownerToken`. Control/action endpoints
**validate ownership server-side** (`authorizeRun`) — a client-supplied `runId`
alone is rejected (403). Telemetry, events, incidents, and actions are scoped by
`runId`. Reset creates a new run and the UI switches to it; old run data expires
later via TTL. Setup never uses `deleteMany({})` on shared collections.

---

## 9. Inspecting the real queries

- **Under the hood** panel (in-app) shows live collection config + the detection,
  keyword, and vector pipelines.
- Each telemetry response includes its `queryMs` and `pipeline`.
- Direct check with `mongosh`:
  ```js
  use property_ops_demo
  db.bops_telemetry.getCollectionInfos ? null : null   // see options via listCollections
  db.getCollectionInfos({name:"bops_telemetry"})[0].options   // timeseries options
  db.bops_knowledge.getSearchIndexes()                        // search index status
  ```

---

## 10. What is synthetic vs. real

| Synthetic (generated locally) | Real MongoDB |
| --- | --- |
| Telemetry values, the fault ramp, security events | Time-series **storage** of every reading |
| Equipment specs & knowledge prose | **`$setWindowFields`** rolling-window detection over persisted data |
| | 1-minute **avg/min/max** chart aggregation (`$dateTrunc` + `$group`) |
| | **Atlas Search** (`$search`) keyword retrieval + highlights |
| | **Vector Search** (`$vectorSearch`, voyage-4 auto-embed) semantic retrieval |
| | Persisted incidents, operator actions, and the work-order draft |

---

## 11. Tests & verification actually executed

- `npm run bops:test` → **28 passed** (22 pure unit + **6 real-MongoDB
  integration**: seed→fault→backend incident with evidence + correlated event;
  incident dedup; wrong-zone/wrong-run correlation exclusion; genuine `$search`
  keyword retrieval; genuine `$vectorSearch` retrieval of the differently-worded
  historical case; live `$searchMeta` facet counts). Integration tests **skip**
  (not fail) if the cluster is unreachable.
- `npm run test:unit` → **28 passed** (pre-existing suite, no regressions).
- `npm run build` → compiles `/control-room` + all `/api/bops/*` routes.
- `npm run lint` / `npx tsc --noEmit` → clean for the new code.
- Manual HTTP verification against the live Atlas cluster: run create/seed,
  overview, fault→detection at ~t+45s, raw+agg charts, keyword+semantic search,
  additive measurement (history absent), work-order persistence, 403 on wrong
  token, acknowledge-vs-recovery separation, pause→stale.

Vector-search assertions check that the relevant differently-worded case appears
among the **top results** (no brittle float-score assertions).

---

## 12. Honest limitations & disclaimers

- **Correlation is not causation.** A nearby door/access event is contextual
  only; the demo never claims it caused the equipment issue.
- **Similar written symptoms are not a diagnosis** or a waveform match. Vector
  scores are **retrieval similarity**, not diagnosis probability.
- **Operator acknowledgment is not equipment recovery.** Workflow status and
  measured condition are tracked separately.
- The prototype **does not control physical equipment** and integrates no BMS,
  PLC, camera, or access-control hardware.
- "Monitored equipment power" is **instantaneous kW** across reporting assets —
  not accumulated energy (kWh), and unlike units are never summed.
- A `runId` in `meta` isolates demo runs; it is **constant for a run** (documented
  tradeoff) and is the only changing-ish identity field — it is not a per-reading
  random value.

## 13. Optional extensions (intentionally deferred)

Storage-efficiency comparison and the sensor-dropout `$densify`/`$fill` overlay
are **not implemented** — the spec lists them as optional and only after the core
workflow. The core workflow is complete and reliable; these can be added later in
the Under-the-hood panel without touching the critical path.
