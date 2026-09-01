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
import {
  findHandwrittenNameCandidates,
  findHandwrittenNameClusters,
  clusterCandidates,
  buildFullTextFromBlocks,
  reorderOcrBlocks,
  HANDWRITING_ILLEGIBLE,
  type OcrBlock,
} from "../src/lib/ocrUtils";

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

// ---------------------------------------------------------------------------
// Handwritten-name candidate detection (HK tenancy multilingual signatures).
// A 1000x1400 "page": printed body top-left, a rotated signature top-right,
// and a low-confidence handwritten name in the footer signature area.
// ---------------------------------------------------------------------------

function block(
  cx: number,
  cy: number,
  w: number,
  h: number,
  extra: Partial<OcrBlock>
): OcrBlock {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const x1 = cx + w / 2;
  const y1 = cy + h / 2;
  return {
    bbox: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    direction: h > w * 1.5 ? "vertical" : "horizontal",
    text: extra.text ?? "x",
    confidence: extra.confidence ?? 0.99,
    angle: extra.angle,
    ...extra,
  };
}

describe("findHandwrittenNameCandidates (LABEL-ANCHORED)", () => {
  // Real HK forms are typeset VERTICALLY (angle=90 everywhere) and printed body
  // text is only medium confidence — so we anchor on printed LABELS and take the
  // adjacent block as the handwritten name.

  it("flags the block adjacent to a 業主 label", () => {
    const label = block(850, 120, 40, 60, { text: "業主：", confidence: 0.9, angle: 90 });
    const name = block(850, 220, 40, 160, { text: "陳藝森", confidence: 0.76, angle: 90 });
    const body = block(400, 700, 40, 300, { text: "租客不得分租", confidence: 0.88, angle: 90 });
    const idx = findHandwrittenNameCandidates([label, name, body]);
    assertIncludes(idx, 1, "name next to 業主 label");
    assert(!idx.includes(2), "far-away printed body excluded");
  });

  it("flags the block adjacent to a 租客 label", () => {
    const label = block(850, 120, 40, 60, { text: "租客", confidence: 0.9, angle: 90 });
    const name = block(850, 210, 40, 140, { text: "劉劍舞", confidence: 0.7, angle: 90 });
    const idx = findHandwrittenNameCandidates([label, name]);
    assertIncludes(idx, 1, "name next to 租客 label");
  });

  it("flags a merged label+name block (業主：陈藝森)", () => {
    const merged = block(760, 90, 520, 100, { text: "業主：陈藝森", confidence: 0.76, angle: 90 });
    const idx = findHandwrittenNameCandidates([merged]);
    assertIncludes(idx, 0, "merged label+name block is itself a candidate");
  });

  it("does NOT flag printed body text with no nearby label", () => {
    const body1 = block(400, 700, 40, 300, { text: "租客不得分租另將樓宇", confidence: 0.88, angle: 90 });
    const body2 = block(500, 700, 40, 300, { text: "業主有合法權利將此", confidence: 0.89, angle: 90 });
    const idx = findHandwrittenNameCandidates([body1, body2]);
    assertEqual(idx, [], "no bare label -> no candidates");
  });

  it("returns [] for empty input", () => {
    assertEqual(findHandwrittenNameCandidates([]), [], "empty in, empty out");
  });
});

describe("clusterCandidates (whole-name grouping)", () => {
  it("merges adjacent single-glyph name blocks into ONE cluster", () => {
    // A 業主 label with the name split into 3 adjacent glyph blocks.
    const label = block(850, 60, 40, 50, { text: "業主", confidence: 0.9, angle: 90 });
    const g1 = block(850, 120, 40, 44, { text: "陈", confidence: 0.7, angle: 90 });
    const g2 = block(850, 165, 40, 44, { text: "藝", confidence: 0.7, angle: 90 });
    const g3 = block(850, 210, 40, 44, { text: "森", confidence: 0.7, angle: 90 });
    const clusters = findHandwrittenNameClusters([label, g1, g2, g3]);
    assertEqual(clusters.length, 1, "adjacent name glyphs -> 1 cluster");
    assert(clusters[0].memberIndices.length >= 1, "cluster has members");
  });
});

describe("handwriting back-fill + fullText assembly", () => {
  it("uses the corrected name in fullText after a candidate is back-filled", () => {
    const sig = block(850, 120, 60, 180, {
      text: "??",
      confidence: 0.5,
      angle: 90,
    });
    // Simulate the multimodal pass back-filling the block text.
    sig.text = "陳大文";
    sig.handwritten = true;
    const ordered = reorderOcrBlocks([sig]);
    assertIncludes(
      buildFullTextFromBlocks(ordered).split("\n"),
      "陳大文",
      "corrected name feeds fullText"
    );
  });

  it("illegible placeholder is a stable, non-empty CJK marker", () => {
    assert(
      HANDWRITING_ILLEGIBLE.length > 0 && HANDWRITING_ILLEGIBLE.includes("手寫"),
      "placeholder is the expected marker"
    );
  });
});

run();
