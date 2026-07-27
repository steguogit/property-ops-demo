import "./_loadEnvOptional";
import {
  describe,
  it,
  assert,
  assertEqual,
  assertIncludes,
  run,
} from "./_harness";
import {
  scopeMatches,
  matchConditions,
  resolveConflicts,
  aggregateActions,
  resolvePolicies,
  buildExpandedQuery,
} from "../src/lib/policy-resolver";
import { detectConflictsAgainst, scopesOverlap } from "../src/lib/conflict-detection";
import { buildTrace } from "../src/lib/policy-trace";
import { KnowledgePolicy } from "../src/lib/mongo";

// ---------------------------------------------------------------------------
// Fixtures — pure, no DB.
// ---------------------------------------------------------------------------

function policy(overrides: Partial<KnowledgePolicy>): KnowledgePolicy {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "POL-x",
    tenantId: overrides.tenantId ?? "default",
    policyType: overrides.policyType ?? "terminology_mapping",
    status: "active",
    version: overrides.version ?? 1,
    name: overrides.name ?? "test policy",
    description: "",
    scope: overrides.scope ?? {},
    matchConditions: overrides.matchConditions ?? {},
    actions: overrides.actions ?? {},
    priority: overrides.priority ?? 50,
    conflictGroup: overrides.conflictGroup ?? null,
    approvedBy: "test",
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as KnowledgePolicy;
}

const guanshuihou = policy({
  id: "POL-gsh",
  policyType: "terminology_mapping",
  scope: { propertyIds: ["grand-yoho"], departmentIds: ["maintenance"], languages: ["zh-Hant", "en"] },
  matchConditions: { terms: ["關水喉"], aliases: ["shut water supply valve"] },
  actions: {
    canonicalTerm: "關水喉",
    canonicalMeaning: "shut or isolate the water supply valve",
    expandQueryWith: ["isolate water supply", "shut water supply valve"],
  },
  priority: 80,
  conflictGroup: "term:關水喉",
});

// ---------------------------------------------------------------------------

describe("scopeMatches (policy scoping)", () => {
  it("matches when context is inside a constrained scope", () => {
    assert(
      scopeMatches(guanshuihou.scope, {
        propertyId: "grand-yoho",
        departmentId: "maintenance",
        language: "zh-Hant",
      }),
      "should match in-scope context"
    );
  });

  it("does NOT match a different property", () => {
    assert(
      !scopeMatches(guanshuihou.scope, {
        propertyId: "icc",
        departmentId: "maintenance",
        language: "zh-Hant",
      }),
      "should not match out-of-scope property"
    );
  });

  it("empty scope dimension means 'any'", () => {
    assert(
      scopeMatches({ languages: ["en"] }, { language: "en", propertyId: "anything" }),
      "unconstrained property should not block"
    );
  });

  it("respects effectiveFrom / effectiveUntil", () => {
    const s = { effectiveFrom: "2999-01-01T00:00:00Z" };
    assert(!scopeMatches(s, { at: "2024-01-01T00:00:00Z" }), "future policy not yet effective");
  });
});

describe("matchConditions (query gating)", () => {
  it("matches when the term appears in the query", () => {
    const m = matchConditions(guanshuihou, "tenant says need 關水喉 for renovation", {});
    assert(m.matched, "term should match");
    assertIncludes(m.detectedTerms, "關水喉", "detected term");
  });

  it("does not match when the term is absent", () => {
    const m = matchConditions(guanshuihou, "how do I book a lift?", {});
    assert(!m.matched, "no term -> no match");
  });

  it("policy with no conditions always matches (scope permitting)", () => {
    const p = policy({ matchConditions: {} });
    const m = matchConditions(p, "anything", {});
    assert(m.matched, "conditionless policy matches");
  });

  it("regex queryPattern matches", () => {
    const p = policy({ matchConditions: { queryPatterns: ["water\\s+leak"] } });
    assert(matchConditions(p, "there is a water   leak", {}).matched, "regex pattern");
  });
});

describe("resolveConflicts (deterministic priority)", () => {
  it("keeps the highest-priority policy in a conflict group", () => {
    const low = policy({ id: "low", priority: 40, conflictGroup: "term:x" });
    const high = policy({ id: "high", priority: 90, conflictGroup: "term:x" });
    const { winners, losers } = resolveConflicts([low, high]);
    assertEqual(winners.map((w) => w.id), ["high"], "high priority wins");
    assertEqual(losers.map((l) => l.id), ["low"], "low priority loses");
  });

  it("breaks priority ties by scope specificity", () => {
    const broad = policy({ id: "broad", priority: 50, conflictGroup: "g", scope: { languages: ["en"] } });
    const narrow = policy({
      id: "narrow",
      priority: 50,
      conflictGroup: "g",
      scope: { propertyIds: ["p"], departmentIds: ["d"] },
    });
    const { winners } = resolveConflicts([broad, narrow]);
    assertEqual(winners.map((w) => w.id), ["narrow"], "narrower scope wins tie");
  });

  it("is deterministic and order-independent", () => {
    const a = policy({ id: "a", priority: 50, conflictGroup: "g" });
    const b = policy({ id: "b", priority: 50, conflictGroup: "g" });
    const r1 = resolveConflicts([a, b]).winners.map((w) => w.id);
    const r2 = resolveConflicts([b, a]).winners.map((w) => w.id);
    assertEqual(r1, r2, "stable regardless of input order");
  });
});

describe("aggregateActions", () => {
  it("aggregates expansion + term meanings", () => {
    const detected = new Map([["POL-gsh", ["關水喉"]]]);
    const agg = aggregateActions([guanshuihou], detected);
    assertIncludes(agg.expandQueryWith, "isolate water supply", "expansion collected");
    assertEqual(agg.termMeanings.length, 1, "one term meaning");
    assertEqual(
      agg.termMeanings[0].meaning,
      "shut or isolate the water supply valve",
      "authoritative meaning"
    );
  });

  it("exclusion overrides boost for the same docId", () => {
    const boostP = policy({ id: "b", policyType: "source_boost", actions: { boostDocumentIds: ["D1"] } });
    const exclP = policy({ id: "e", policyType: "document_exclusion", actions: { excludeDocumentIds: ["D1"] } });
    const agg = aggregateActions([boostP, exclP], new Map());
    assert(!agg.boostDocumentIds.includes("D1"), "D1 not boosted");
    assertIncludes(agg.excludeDocumentIds, "D1", "D1 excluded");
  });
});

describe("resolvePolicies (end-to-end, injected policies)", () => {
  it("applies the 關水喉 policy to an in-scope query", async () => {
    const plan = await resolvePolicies(
      "tenant says need 關水喉 for renovation",
      { tenantId: "default", propertyId: "grand-yoho", departmentId: "maintenance", language: "zh-Hant" },
      [guanshuihou]
    );
    assertEqual(plan.appliedPolicies.map((p) => p.id), ["POL-gsh"], "policy applied");
    assertIncludes(plan.detectedTerms, "關水喉", "term detected");
    assertIncludes(plan.expandQueryWith, "shut water supply valve", "query expanded");
    assertEqual(plan.termMeanings[0].term, "關水喉", "term meaning present");
  });

  it("does NOT apply the policy to an out-of-scope property", async () => {
    const plan = await resolvePolicies(
      "need 關水喉 at ICC",
      { tenantId: "default", propertyId: "icc", departmentId: "maintenance", language: "zh-Hant" },
      [guanshuihou]
    );
    assertEqual(plan.appliedPolicies.length, 0, "no policy applied out of scope");
    assertIncludes(plan.skippedPolicyIds, "POL-gsh", "skipped out-of-scope policy");
  });

  it("buildExpandedQuery preserves the original and appends expansions", () => {
    const plan = {
      appliedPolicies: [],
      skippedPolicyIds: [],
      detectedTerms: [],
      expandQueryWith: ["isolate water supply"],
      termMeanings: [],
      boostDocumentIds: [],
      demoteDocumentIds: [],
      excludeDocumentIds: [],
      preferDocumentIds: [],
      preferLatestVersion: false,
      rerankDeltas: {},
      answerInstructions: [],
    };
    const q = buildExpandedQuery("關水喉", plan as any);
    assert(q.startsWith("關水喉"), "original preserved first");
    assert(q.includes("isolate water supply"), "expansion appended");
  });
});

describe("conflict detection", () => {
  it("scopesOverlap: disjoint properties do not overlap", () => {
    assert(
      !scopesOverlap({ propertyIds: ["a"] }, { propertyIds: ["b"] }),
      "disjoint property scopes"
    );
    assert(scopesOverlap({ propertyIds: ["a"] }, { propertyIds: ["a", "b"] }), "shared property");
  });

  it("flags contradictory term mapping", () => {
    const candidate = {
      policyType: "terminology_mapping" as const,
      scope: guanshuihou.scope,
      matchConditions: { terms: ["關水喉"] },
      actions: { canonicalTerm: "關水喉", canonicalMeaning: "close the faucet" },
      term: "關水喉",
    };
    const hits = detectConflictsAgainst(candidate, [guanshuihou]);
    assertIncludes(
      hits.map((h) => h.conflictType),
      "contradictory_term_mapping",
      "contradiction detected"
    );
  });

  it("flags boost/demote on the same source", () => {
    const demoteP = policy({ id: "d", policyType: "source_demotion", actions: { demoteDocumentIds: ["D9"] } });
    const candidate = {
      policyType: "source_boost" as const,
      scope: {},
      matchConditions: {},
      actions: { boostDocumentIds: ["D9"] },
    };
    const hits = detectConflictsAgainst(candidate, [demoteP]);
    assertIncludes(
      hits.map((h) => h.conflictType),
      "boost_and_demote_same_source",
      "boost/demote conflict"
    );
  });
});

describe("policy trace", () => {
  it("builds a trace describing applied policies + adjustments", () => {
    const plan = {
      appliedPolicies: [guanshuihou],
      skippedPolicyIds: [],
      detectedTerms: ["關水喉"],
      expandQueryWith: ["isolate water supply"],
      termMeanings: [{ term: "關水喉", meaning: "shut or isolate the water supply valve" }],
      boostDocumentIds: ["SOP-1"],
      demoteDocumentIds: [],
      excludeDocumentIds: [],
      preferDocumentIds: [],
      preferLatestVersion: false,
      rerankDeltas: { "SOP-1": 1 },
      answerInstructions: [],
    };
    const trace = buildTrace({ queryText: "關水喉?", expandedQuery: "關水喉? isolate water supply", plan: plan as any });
    assertEqual(trace.appliedPolicyIds, ["POL-gsh"], "trace lists applied policy");
    assertIncludes(trace.detectedTerms ?? [], "關水喉", "trace detected term");
    assertEqual(trace.retrievalAdjustments.boostedDocumentIds, ["SOP-1"], "trace boost");
    assert(trace.explanation.includes("關水喉"), "explanation mentions the term");
  });
});

run();
