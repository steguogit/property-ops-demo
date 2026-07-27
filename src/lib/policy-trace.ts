import {
  PolicyApplicationTrace,
  getPolicyTracesCollection,
} from "./mongo";
import { ResolvedPolicyPlan } from "./policy-resolver";
import { env } from "./env";

// ---------------------------------------------------------------------------
// PolicyApplicationTrace — runtime explainability & audit.
//
// Every query that passes through the policy layer produces a trace describing
// which policies applied, which were skipped, what terms were detected, how the
// query was expanded, and what retrieval adjustments were made. This is the
// deterministic audit record reviewers use to answer "why did the assistant
// behave this way for this query?".
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface BuildTraceInput {
  tenantId?: string;
  conversationId?: string | null;
  queryText: string;
  expandedQuery?: string | null;
  plan: ResolvedPolicyPlan;
}

/** Build a trace object (pure — does not persist). */
export function buildTrace(input: BuildTraceInput): PolicyApplicationTrace {
  const { plan } = input;
  const id = newId("TRACE");

  const parts: string[] = [];
  if (plan.appliedPolicies.length) {
    parts.push(
      `Applied ${plan.appliedPolicies.length} policy(ies): ${plan.appliedPolicies
        .map((p) => `${p.id} (${p.policyType})`)
        .join(", ")}.`
    );
  } else {
    parts.push("No policies matched this query.");
  }
  if (plan.detectedTerms.length) {
    parts.push(`Detected terms: ${plan.detectedTerms.join(", ")}.`);
  }
  if (plan.expandQueryWith.length) {
    parts.push(`Query expanded with: ${plan.expandQueryWith.join(", ")}.`);
  }
  if (plan.termMeanings.length) {
    parts.push(
      `Grounded term meanings: ${plan.termMeanings
        .map((t) => `"${t.term}" = ${t.meaning}`)
        .join("; ")}.`
    );
  }
  if (plan.boostDocumentIds.length) {
    parts.push(`Boosted: ${plan.boostDocumentIds.join(", ")}.`);
  }
  if (plan.demoteDocumentIds.length) {
    parts.push(`Demoted: ${plan.demoteDocumentIds.join(", ")}.`);
  }
  if (plan.excludeDocumentIds.length) {
    parts.push(`Excluded: ${plan.excludeDocumentIds.join(", ")}.`);
  }
  if (plan.preferDocumentIds.length || plan.preferLatestVersion) {
    parts.push(
      `Preferred: ${
        plan.preferLatestVersion ? "latest version" : ""
      }${plan.preferDocumentIds.length ? ` ${plan.preferDocumentIds.join(", ")}` : ""}.`
    );
  }
  if (plan.skippedPolicyIds.length) {
    parts.push(
      `Skipped ${plan.skippedPolicyIds.length} policy(ies) (out of scope / no match / lost conflict).`
    );
  }

  return {
    _id: id,
    id,
    tenantId: input.tenantId ?? env.defaultTenantId,
    conversationId: input.conversationId ?? null,
    queryId: newId("Q"),
    queryText: input.queryText,
    appliedPolicyIds: plan.appliedPolicies.map((p) => p.id),
    skippedPolicyIds: plan.skippedPolicyIds,
    detectedTerms: plan.detectedTerms,
    expandedQuery: input.expandedQuery ?? null,
    retrievalAdjustments: {
      boostedDocumentIds: plan.boostDocumentIds,
      demotedDocumentIds: plan.demoteDocumentIds,
      excludedDocumentIds: plan.excludeDocumentIds,
      preferredDocumentIds: plan.preferDocumentIds,
    },
    rankingAdjustments: Object.keys(plan.rerankDeltas).length
      ? { rerankDeltas: plan.rerankDeltas }
      : null,
    explanation: parts.join(" "),
    createdAt: new Date().toISOString(),
  };
}

/** Build and persist a trace. Best-effort — never throws into the query path. */
export async function recordTrace(
  input: BuildTraceInput
): Promise<PolicyApplicationTrace> {
  const trace = buildTrace(input);
  try {
    const col = await getPolicyTracesCollection();
    await col.insertOne(trace as any);
  } catch {
    /* tracing must never break retrieval */
  }
  return trace;
}

export async function listTraces(
  tenantId = env.defaultTenantId,
  limit = 50
): Promise<PolicyApplicationTrace[]> {
  const col = await getPolicyTracesCollection();
  return col
    .find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}
