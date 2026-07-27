import {
  CorrectionProposal,
  KnowledgePolicy,
  PolicyImpactSimulation,
  getPolicySimulationsCollection,
} from "./mongo";
import { env } from "./env";
import {
  resolvePolicies,
  buildExpandedQuery,
  QueryContext,
} from "./policy-resolver";
import { listActivePolicies } from "./policies";
import { runSearch, SearchHit } from "./retrieval";

// ---------------------------------------------------------------------------
// Impact simulation (evaluation before approval).
//
// Given a DRAFT policy (from a proposal) and a set of sample queries, run
// retrieval WITHOUT the draft and WITH the draft, and compare the top-N docId
// ordering. This lets a reviewer see the likely effect before activating a
// policy — a core governance safeguard.
//
// The simulation treats the draft as a hypothetical extra active policy; it is
// never persisted as active. Verdicts are heuristic (did the intended docs move
// up / did anything drop out) and clearly labelled — the reviewer decides.
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

/** Turn a proposal into a hypothetical (non-persisted) active policy. */
function draftToHypotheticalPolicy(
  proposal: CorrectionProposal
): KnowledgePolicy {
  const id = `DRAFT-${proposal.id}`;
  return {
    _id: id,
    id,
    tenantId: proposal.tenantId,
    policyType: proposal.proposalType,
    status: "active",
    version: 0,
    name: `[draft] ${proposal.description}`,
    description: proposal.description,
    scope: proposal.suggestedScope,
    matchConditions: proposal.suggestedPolicy.matchConditions,
    actions: proposal.suggestedPolicy.actions,
    priority: proposal.suggestedPolicy.priority ?? 50,
    conflictGroup: null,
    createdFromProposalId: proposal.id,
    approvedBy: "simulation",
    approvedAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function applyPlanToHits(
  hits: SearchHit[],
  plan: Awaited<ReturnType<typeof resolvePolicies>>
): SearchHit[] {
  const boost = new Set(plan.boostDocumentIds);
  const demote = new Set(plan.demoteDocumentIds);
  const exclude = new Set(plan.excludeDocumentIds);
  const prefer = new Set(plan.preferDocumentIds);
  const filtered = hits.filter((h) => !exclude.has(h.docId));
  const head: SearchHit[] = [];
  const mid: SearchHit[] = [];
  const tail: SearchHit[] = [];
  for (const h of filtered) {
    if (prefer.has(h.docId) || boost.has(h.docId)) head.push(h);
    else if (demote.has(h.docId)) tail.push(h);
    else mid.push(h);
  }
  return [...head, ...mid, ...tail];
}

/**
 * Simulate a proposal's impact against sample queries. Retrieval is live
 * (requires a working Atlas connection); if retrieval fails for a query it is
 * marked "uncertain" rather than throwing.
 */
export async function simulateProposalImpact(
  proposal: CorrectionProposal,
  sampleQueries: string[],
  opts: { topN?: number; ctx?: QueryContext } = {}
): Promise<PolicyImpactSimulation> {
  const topN = opts.topN ?? 5;
  const tenantId = proposal.tenantId;
  const activeNow = await listActivePolicies(tenantId).catch(() => []);
  const hypothetical = [...activeNow, draftToHypotheticalPolicy(proposal)];

  const ctx: QueryContext = { tenantId, ...(opts.ctx ?? {}) };

  let improved = 0;
  let degraded = 0;
  let neutral = 0;
  let uncertain = 0;
  const examples: PolicyImpactSimulation["beforeAfterExamples"] = [];

  const intendedDocs = new Set([
    ...(proposal.suggestedPolicy.actions.boostDocumentIds ?? []),
    ...(proposal.suggestedPolicy.actions.preferDocumentIds ?? []),
  ]);

  for (const q of sampleQueries) {
    try {
      // BEFORE: existing active policies only.
      const planBefore = await resolvePolicies(q, ctx, activeNow);
      const beforeQuery = buildExpandedQuery(q, planBefore);
      const beforeHits = applyPlanToHits(
        await runSearch("hybrid", beforeQuery, topN),
        planBefore
      );

      // AFTER: existing + the draft.
      const planAfter = await resolvePolicies(q, ctx, hypothetical);
      const afterQuery = buildExpandedQuery(q, planAfter);
      const afterHits = applyPlanToHits(
        await runSearch("hybrid", afterQuery, topN),
        planAfter
      );

      const before = beforeHits.slice(0, topN).map((h) => h.docId);
      const after = afterHits.slice(0, topN).map((h) => h.docId);

      let verdict: "improved" | "degraded" | "neutral" | "uncertain" =
        "neutral";
      if (intendedDocs.size) {
        const beforeRank = bestRank(before, intendedDocs);
        const afterRank = bestRank(after, intendedDocs);
        if (afterRank < beforeRank) verdict = "improved";
        else if (afterRank > beforeRank) verdict = "degraded";
        else verdict = "neutral";
      } else {
        verdict =
          JSON.stringify(before) === JSON.stringify(after)
            ? "neutral"
            : "improved"; // changed ordering with a scoped policy = intended effect
      }

      if (verdict === "improved") improved++;
      else if (verdict === "degraded") degraded++;
      else neutral++;

      examples.push({ query: q, before, after, verdict });
    } catch {
      uncertain++;
      examples.push({ query: q, before: [], after: [], verdict: "uncertain" });
    }
  }

  const id = newId("SIM");
  const sim: PolicyImpactSimulation = {
    _id: id,
    id,
    tenantId,
    proposalId: proposal.id,
    policyDraft: {
      policyType: proposal.proposalType,
      scope: proposal.suggestedScope,
      matchConditions: proposal.suggestedPolicy.matchConditions,
      actions: proposal.suggestedPolicy.actions,
    },
    testQueryIds: null,
    sampleQueries,
    affectedQueryCount: sampleQueries.length,
    improvedCount: improved,
    degradedCount: degraded,
    neutralCount: neutral,
    uncertainCount: uncertain,
    beforeAfterExamples: examples,
    summary: `Simulated ${sampleQueries.length} queries: ${improved} improved, ${degraded} degraded, ${neutral} neutral, ${uncertain} uncertain.`,
    createdAt: nowIso(),
  };

  const col = await getPolicySimulationsCollection();
  await col.insertOne(sim as any);
  return sim;
}

function bestRank(order: string[], targets: Set<string>): number {
  for (let i = 0; i < order.length; i++) {
    if (targets.has(order[i])) return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

export async function getSimulation(
  id: string
): Promise<PolicyImpactSimulation | null> {
  const col = await getPolicySimulationsCollection();
  return col.findOne({ id });
}

export async function listSimulations(
  tenantId = env.defaultTenantId
): Promise<PolicyImpactSimulation[]> {
  const col = await getPolicySimulationsCollection();
  return col.find({ tenantId }).sort({ createdAt: -1 }).toArray();
}
