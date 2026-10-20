// =============================================================================
// Building Operations Control Room tests.
//
//   * Unit tests (pure, no DB): deterministic simulation, fault progression,
//     anomaly threshold/window/min-sample logic, consecutive-breach rule,
//     correlation-window boundary math, additive-measurement history behavior.
//   * Integration tests (REAL MongoDB): gated on connectivity. They seed a run,
//     inject the fault, and assert a backend-detected incident with correct
//     evidence + correlated event, dedup, run isolation, and genuine keyword +
//     vector retrieval. Skipped (not failed) when the cluster is unreachable.
//
// Run: npm run bops:test
// =============================================================================
import "./_loadEnvOptional";
import { describe, it, itSkip, assert, assertEqual, run } from "./_harness";
import {
  generateReading,
  generateTick,
  generateHistory,
  faultProgress,
  buildScenarioDoorEvent,
  NO_FAULT,
  type FaultState,
} from "../src/lib/bops/simulator";
import {
  classifyBreach,
  latestConsecutiveBreach,
  buildDetectionPipeline,
  type DetectionResultSample,
} from "../src/lib/bops/anomaly";
import {
  buildKeywordPipeline,
  buildVectorPipeline,
  buildFacetPipeline,
} from "../src/lib/bops/knowledge";
import { ANOMALY_RULE, CORRELATION, FAULT_TARGET_ASSET_ID } from "../src/lib/bops/config";

// ---------------------------------------------------------------------------
// UNIT — deterministic simulator
// ---------------------------------------------------------------------------
describe("simulator — determinism", () => {
  it("same (run, asset, ts) produces identical readings", () => {
    const a = generateReading("RUN-T", "CHILLER-01", 1_700_000_000_000, NO_FAULT);
    const b = generateReading("RUN-T", "CHILLER-01", 1_700_000_000_000, NO_FAULT);
    assertEqual(a.leavingChilledWaterTempC, b.leavingChilledWaterTempC, "temp deterministic");
    assertEqual(a.compressorVibrationMmS, b.compressorVibrationMmS, "vibration deterministic");
  });

  it("different runs diverge (per-run isolation of noise)", () => {
    const a = generateReading("RUN-A", "CHILLER-01", 1_700_000_000_000, NO_FAULT);
    const b = generateReading("RUN-B", "CHILLER-01", 1_700_000_000_000, NO_FAULT);
    assert(
      a.leavingChilledWaterTempC !== b.leavingChilledWaterTempC,
      "different runs should produce different noise"
    );
  });

  it("normal readings sit near the chiller setpoint (~6.7 °C)", () => {
    const r = generateReading("RUN-T", "CHILLER-01", 1_700_000_000_000, NO_FAULT);
    assert(
      Math.abs((r.leavingChilledWaterTempC ?? 0) - 6.7) < 1.0,
      `normal temp should be ~6.7, got ${r.leavingChilledWaterTempC}`
    );
  });

  it("history has no duplicate timestamps per asset and is chronological", () => {
    const end = 1_700_000_900_000;
    const hist = generateHistory("RUN-T", end, 15, 5000);
    const chiller = hist.filter((r) => r.meta.assetId === "CHILLER-01").map((r) => r.ts.getTime());
    const uniq = new Set(chiller);
    assertEqual(uniq.size, chiller.length, "no duplicate timestamps");
    for (let i = 1; i < chiller.length; i++) assert(chiller[i] > chiller[i - 1], "chronological");
  });

  it("additive signal is absent until enabled, present after", () => {
    const off = generateReading("RUN-T", "CHILLER-01", 1_700_000_000_000, NO_FAULT, []);
    assert(off.differentialPressureKpa === undefined, "dp absent when not enabled");
    const on = generateReading("RUN-T", "CHILLER-01", 1_700_000_000_000, NO_FAULT, [
      "differentialPressureKpa",
    ]);
    assert(typeof on.differentialPressureKpa === "number", "dp present when enabled");
  });

  it("generateTick covers all three mechanical assets", () => {
    const tick = generateTick("RUN-T", 1_700_000_000_000, NO_FAULT);
    const ids = tick.map((r) => r.meta.assetId).sort();
    assertEqual(ids, ["AHU-10", "CHILLER-01", "PUMP-01"], "all mechanical assets");
  });
});

// ---------------------------------------------------------------------------
// UNIT — fault progression
// ---------------------------------------------------------------------------
describe("simulator — fault progression", () => {
  const start = 1_700_000_000_000;
  const fault: FaultState = { faultStartMs: start, recoveryStartMs: null };

  it("ramps 0 → 1 over the ramp window", () => {
    assertEqual(faultProgress(start, fault), 0, "p=0 at injection");
    assert(faultProgress(start + 22500, fault) > 0.4, "midway ~0.5");
    assertEqual(faultProgress(start + 60000, fault), 1, "p=1 after ramp");
  });

  it("fault raises leaving chilled-water temperature materially", () => {
    const normal = generateReading("RUN-T", "CHILLER-01", start, NO_FAULT)!.leavingChilledWaterTempC!;
    const faulted = generateReading("RUN-T", "CHILLER-01", start + 60000, fault)!.leavingChilledWaterTempC!;
    assert(faulted - normal > ANOMALY_RULE.thresholdDeltaC, `fault delta ${faulted - normal} should exceed threshold`);
  });

  it("recovery ramps the value back down", () => {
    const recovering: FaultState = { faultStartMs: start, recoveryStartMs: start + 60000 };
    assertEqual(faultProgress(start + 60000 + 40000, recovering), 0, "fully recovered");
    assert(faultProgress(start + 60000 + 10000, recovering) < 1, "partway recovered");
  });

  it("fault only affects the target chiller, not the pump", () => {
    const pumpNormal = generateReading("RUN-T", "PUMP-01", start, NO_FAULT)!.flowRateLps!;
    const pumpFaulted = generateReading("RUN-T", "PUMP-01", start + 60000, fault)!.flowRateLps!;
    assert(Math.abs(pumpNormal - pumpFaulted) < 2, "pump unaffected by chiller fault");
  });
});

// ---------------------------------------------------------------------------
// UNIT — anomaly rule logic
// ---------------------------------------------------------------------------
describe("anomaly — threshold & warm-up", () => {
  it("does not breach below the delta threshold", () => {
    assertEqual(classifyBreach(6.7 + 1.0, 6.7, 100), false, "1.0°C < 1.6°C threshold");
  });
  it("breaches at/above the delta threshold with enough samples", () => {
    assertEqual(classifyBreach(6.7 + 1.7, 6.7, 100), true, "1.7°C >= 1.6°C threshold");
  });
  it("suppresses breach during warm-up (too few baseline samples)", () => {
    assertEqual(
      classifyBreach(6.7 + 3.0, 6.7, ANOMALY_RULE.minBaselineSamples - 1),
      false,
      "below min samples → no breach even if far over threshold"
    );
  });
});

describe("anomaly — consecutive-breach noise guard", () => {
  const mk = (breach: boolean): DetectionResultSample => ({
    ts: new Date(),
    observed: 0,
    baselineMean: 0,
    baselineCount: 100,
    deltaOverBaseline: 0,
    breach,
  });
  it("single transient breach does not fire", () => {
    const series = [mk(false), mk(true), mk(false), mk(true), mk(false)];
    assertEqual(latestConsecutiveBreach(series, ANOMALY_RULE.consecutiveBreaches), null, "no run of N");
  });
  it("N consecutive breaches fire", () => {
    const series = [mk(false), mk(true), mk(true), mk(true), mk(true)];
    const hit = latestConsecutiveBreach(series, ANOMALY_RULE.consecutiveBreaches);
    assert(hit !== null, "should detect a run of 4");
    assertEqual(hit!.run.length, ANOMALY_RULE.consecutiveBreaches, "run length");
  });
});

describe("anomaly — detection pipeline shape", () => {
  it("partitions by run+asset and uses $setWindowFields with an excluded-recent baseline", () => {
    const p = buildDetectionPipeline("RUN-X", "CHILLER-01") as any[];
    const match = p[0].$match;
    assertEqual(match["meta.runId"], "RUN-X", "scoped to run");
    assertEqual(match["meta.assetId"], "CHILLER-01", "scoped to asset");
    const swf = p.find((s) => s.$setWindowFields)?.$setWindowFields;
    assert(!!swf, "uses $setWindowFields");
    const win = swf.output.baselineMean.window.range;
    assertEqual(win[0], -ANOMALY_RULE.baselineWindowSeconds, "baseline window start");
    assertEqual(win[1], -ANOMALY_RULE.baselineExcludeRecentSeconds, "excludes recent samples");
  });
});

// ---------------------------------------------------------------------------
// UNIT — correlation window boundaries
// ---------------------------------------------------------------------------
describe("correlation — window boundaries", () => {
  const detection = 1_700_000_000_000;
  const within = (ms: number) =>
    ms >= detection - CORRELATION.windowSecondsBefore * 1000 &&
    ms <= detection + CORRELATION.windowSecondsAfter * 1000;

  it("event just inside the window is included", () => {
    assert(within(detection - (CORRELATION.windowSecondsBefore - 1) * 1000), "inside before edge");
    assert(within(detection + (CORRELATION.windowSecondsAfter - 1) * 1000), "inside after edge");
  });
  it("event outside the window is excluded", () => {
    assert(!within(detection - (CORRELATION.windowSecondsBefore + 5) * 1000), "outside before");
    assert(!within(detection + (CORRELATION.windowSecondsAfter + 5) * 1000), "outside after");
  });
  it("scenario door event is in the plant-room zone", () => {
    const ev = buildScenarioDoorEvent("RUN-T", detection);
    assertEqual(ev.zoneId, "ZONE-B2-PLANT", "door event zone");
    assertEqual(ev.eventType, "door_held_open", "door event type");
    assert(ev.simulated === true, "flagged synthetic");
  });
});

// ---------------------------------------------------------------------------
// UNIT — search pipeline shape (no DB)
// ---------------------------------------------------------------------------
describe("knowledge — pipeline shapes", () => {
  it("keyword uses $search with equals filters for token fields", () => {
    const p = buildKeywordPipeline("chiller vibration", { equipmentType: "chiller" as any }, 6) as any[];
    assert(!!p[0].$search, "uses $search (real Atlas Search, not regex)");
    const filt = p[0].$search.compound.filter;
    assert(Array.isArray(filt) && filt[0].equals, "token field filtered with equals");
  });
  it("vector uses $vectorSearch with a text query (Atlas auto-embedding)", () => {
    const p = buildVectorPipeline("symptoms", { equipmentType: "chiller" as any }, 6) as any[];
    assert(!!p[0].$vectorSearch, "uses $vectorSearch");
    assert(!!p[0].$vectorSearch.query?.text, "auto-embed: query text (no client vector)");
    assertEqual(p[0].$vectorSearch.path, "chunkText", "embeds chunkText");
  });
  it("facet navigation uses $searchMeta with a facet collector", () => {
    const p = buildFacetPipeline("chiller") as any[];
    assert(!!p[0].$searchMeta?.facet, "uses $searchMeta facet collector");
    assert(!!p[0].$searchMeta.facet.facets.equipmentType, "equipmentType facet");
    assert(!!p[0].$searchMeta.facet.facets.docType, "docType facet");
  });
});

describe("knowledge — facets (real MongoDB)", () => {
  it("live facet counts are returned when the lexical index is ready", async () => {
    if (!dbReachable) {
      assert(true, "DB unreachable — covered by skipped integration suite");
      return;
    }
    const { keywordFacets, searchReadiness } = await import("../src/lib/bops/knowledge");
    const ready = await searchReadiness();
    if (ready.lexical !== "ready") {
      assert(true, `lexical index not ready (${ready.lexical}) — skipping assertion`);
      return;
    }
    const f = await keywordFacets("chiller");
    assert(f.equipmentType.length > 0, "equipmentType facet buckets returned");
    assert(
      f.equipmentType.every((b) => typeof b.count === "number"),
      "facet counts are plain numbers (BSON Long coerced)"
    );
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION — real MongoDB. Gated on connectivity.
// ---------------------------------------------------------------------------
let dbReachable = false;
async function probe(): Promise<boolean> {
  if (!process.env.MONGODB_URI) return false;
  try {
    const { getDb } = await import("../src/lib/mongo");
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  dbReachable = await probe();
  if (!dbReachable) {
    describe("integration — SKIPPED (MongoDB unreachable or MONGODB_URI unset)", () => {
      itSkip("seed → fault → backend incident with evidence + correlation", async () => {});
      itSkip("incident dedup across repeated detection", async () => {});
      itSkip("wrong-zone / wrong-run events are excluded from correlation", async () => {});
      itSkip("real keyword search returns filtered chiller results", async () => {});
      itSkip("real vector search retrieves the differently-worded historical case", async () => {});
    });
    await run();
    process.exit(0);
  }

  describe("integration — end to end (real MongoDB)", () => {
    it("seed → fault → backend incident with evidence + correlated event", async () => {
      const { createRun, updateRun } = await import("../src/lib/bops/runs");
      const { seedHistory } = await import("../src/lib/bops/worker");
      const { telemetryCol, eventsCol, incidentsCol } = await import("../src/lib/bops/mongo");
      const { evaluateAndPersist } = await import("../src/lib/bops/anomaly");
      const { generateTick, buildScenarioDoorEvent, faultProgress } = await import(
        "../src/lib/bops/simulator"
      );

      const runRec = await createRun("test-e2e");
      const runId = runRec.runId;
      await updateRun(runId, { simulatorStatus: "running" });

      // Seed ~15 min normal history ending "now".
      const nowMs = Math.floor(Date.now() / 5000) * 5000;
      await seedHistory(runId);

      // Drive a fault ramp forward in time (simulate ~60s of 5s ticks).
      const tcol = await telemetryCol();
      const faultStart = nowMs + 5000;
      const fault = { faultStartMs: faultStart, recoveryStartMs: null };
      for (let i = 1; i <= 14; i++) {
        const ts = nowMs + i * 5000;
        const readings = generateTick(runId, ts, fault);
        await tcol.insertMany(readings, { ordered: false });
      }
      // Independent door event ~25s into the scenario.
      const ecol = await eventsCol();
      await ecol.insertOne(buildScenarioDoorEvent(runId, faultStart + 25000) as any);

      const res = await evaluateAndPersist(runId, FAULT_TARGET_ASSET_ID);
      assert(res.incidentId !== null, "an incident should be created");

      const inc = await (await incidentsCol()).findOne({ incidentId: res.incidentId! });
      assert(!!inc, "incident persisted");
      const e = inc!.evidence;
      assert(e.observedValue - e.baselineMean >= e.thresholdDeltaC, "evidence breaches threshold");
      assert(e.validSampleCount >= ANOMALY_RULE.minBaselineSamples, "min samples satisfied");
      assertEqual(e.primaryUnit, "°C", "primary unit");
      assert(e.consecutiveBreaches >= ANOMALY_RULE.consecutiveBreaches, "consecutive breaches");
      assert(
        inc!.relatedEvents.some((r) => r.eventType === "door_held_open"),
        "door event correlated as context"
      );

      // cleanup this run
      await tcol.deleteMany({ "meta.runId": runId });
      await ecol.deleteMany({ runId });
      await (await incidentsCol()).deleteMany({ runId });
    });

    it("incident dedup — repeated evaluation does not create duplicates", async () => {
      const { createRun, updateRun } = await import("../src/lib/bops/runs");
      const { seedHistory } = await import("../src/lib/bops/worker");
      const { telemetryCol, eventsCol, incidentsCol } = await import("../src/lib/bops/mongo");
      const { evaluateAndPersist } = await import("../src/lib/bops/anomaly");
      const { generateTick } = await import("../src/lib/bops/simulator");

      const runRec = await createRun("test-dedup");
      const runId = runRec.runId;
      await updateRun(runId, { simulatorStatus: "running" });
      const nowMs = Math.floor(Date.now() / 5000) * 5000;
      await seedHistory(runId);
      const tcol = await telemetryCol();
      const fault = { faultStartMs: nowMs + 5000, recoveryStartMs: null };
      for (let i = 1; i <= 14; i++) {
        await tcol.insertMany(generateTick(runId, nowMs + i * 5000, fault), { ordered: false });
      }
      await evaluateAndPersist(runId, FAULT_TARGET_ASSET_ID);
      await evaluateAndPersist(runId, FAULT_TARGET_ASSET_ID);
      await evaluateAndPersist(runId, FAULT_TARGET_ASSET_ID);
      const count = await (await incidentsCol()).countDocuments({ runId });
      assertEqual(count, 1, "exactly one incident despite repeated evaluation");

      await tcol.deleteMany({ "meta.runId": runId });
      await (await eventsCol()).deleteMany({ runId });
      await (await incidentsCol()).deleteMany({ runId });
    });

    it("correlation excludes wrong-zone and wrong-run events", async () => {
      const { createRun } = await import("../src/lib/bops/runs");
      const { eventsCol } = await import("../src/lib/bops/mongo");
      const { correlateEvents } = await import("../src/lib/bops/anomaly");
      const { SITE } = await import("../src/lib/bops/config");

      const runRec = await createRun("test-corr");
      const runId = runRec.runId;
      const detection = new Date();
      const ecol = await eventsCol();
      const base = {
        runId,
        siteId: SITE.siteId,
        buildingId: SITE.buildingId,
        system: "security" as const,
        severity: "low" as const,
        details: {},
        simulated: true as const,
        createdAt: new Date(),
      };
      // in-zone, in-window → included
      await ecol.insertOne({
        ...base,
        eventId: `EVT-${runId}-good`,
        eventTime: new Date(detection.getTime() - 10000),
        deviceId: "DOOR-B2-01",
        zoneId: "ZONE-B2-PLANT",
        eventType: "door_held_open",
      } as any);
      // wrong zone → excluded
      await ecol.insertOne({
        ...base,
        eventId: `EVT-${runId}-wrongzone`,
        eventTime: new Date(detection.getTime() - 10000),
        deviceId: "X",
        zoneId: "ZONE-GF-LOBBY",
        eventType: "access_granted",
      } as any);
      // wrong run → excluded
      await ecol.insertOne({
        ...base,
        eventId: `EVT-OTHERRUN-x`,
        runId: "RUN-OTHER",
        eventTime: new Date(detection.getTime() - 10000),
        deviceId: "Y",
        zoneId: "ZONE-B2-PLANT",
        eventType: "access_granted",
      } as any);
      // out of window → excluded
      await ecol.insertOne({
        ...base,
        eventId: `EVT-${runId}-oldwindow`,
        eventTime: new Date(detection.getTime() - 999000),
        deviceId: "Z",
        zoneId: "ZONE-B2-PLANT",
        eventType: "access_granted",
      } as any);

      const related = await correlateEvents(runId, "CHILLER-01", detection);
      const ids = related.map((r) => r.eventId);
      assert(ids.includes(`EVT-${runId}-good`), "in-zone in-window event included");
      assert(!ids.includes(`EVT-${runId}-wrongzone`), "wrong-zone excluded");
      assert(!ids.includes("EVT-OTHERRUN-x"), "wrong-run excluded");
      assert(!ids.includes(`EVT-${runId}-oldwindow`), "out-of-window excluded");

      await ecol.deleteMany({ runId });
      await ecol.deleteMany({ eventId: "EVT-OTHERRUN-x" });
    });

    it("real keyword search ($search) returns filtered chiller results", async () => {
      const { keywordSearch, searchReadiness } = await import("../src/lib/bops/knowledge");
      const ready = await searchReadiness();
      if (ready.lexical !== "ready") {
        assert(true, `lexical index not ready (${ready.lexical}) — skipping assertion`);
        return;
      }
      const { hits } = await keywordSearch("chiller vibration", { equipmentType: "chiller" as any }, 5);
      assert(hits.length > 0, "keyword search returns results");
      assert(hits.every((h) => h.equipmentType === "chiller"), "filter respected");
      assert(
        hits.some((h) => /vibration/i.test(h.title) || /vibration/i.test(h.excerpt)),
        "relevant vibration doc present"
      );
    });

    it("real vector search ($vectorSearch) retrieves the differently-worded historical case", async () => {
      const { semanticSearch, searchReadiness } = await import("../src/lib/bops/knowledge");
      const ready = await searchReadiness();
      if (ready.vector !== "ready") {
        assert(true, `vector index not ready (${ready.vector}) — skipping assertion`);
        return;
      }
      const q =
        "Cooling output is worsening while the machine shakes more and draws additional electricity.";
      const { hits } = await semanticSearch(
        q,
        { equipmentType: "chiller" as any, docType: "historical_incident" as any },
        3
      );
      assert(hits.length > 0, "vector search returns results");
      // The relevant 2024 case uses different wording ("Reduced cooling capacity
      // accompanied by elevated compressor vibration and increased input power").
      assert(
        hits.slice(0, 2).some((h) => h.docId === "KB-CHILLER-HIST-010"),
        "differently-worded 2024 historical case is among the top results"
      );
    });
  });

  await run();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
