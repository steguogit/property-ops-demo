import {
  KnowledgePolicy,
  CorrectionProposal,
  PolicyConflict,
  ConflictType,
  ConflictSeverity,
  PolicyScope,
  getPolicyConflictsCollection,
} from "./mongo";
import { listActivePolicies } from "./policies";
import { env } from "./env";

// ---------------------------------------------------------------------------
// Conflict detection.
//
// Runs when a proposal is drafted (advisory) and can be re-run across active
// policies (governance). It flags:
//   - contradictory_term_mapping: same term, different canonical meaning
//   - boost_and_demote_same_source: one policy boosts a docId another demotes
//   - exclusion_conflict: a docId is excluded and also boosted/preferred
//   - version_preference_conflict: conflicting version preferences
//   - overlapping_scope: two policies with overlapping scope + same subject
//   - duplicate_policy: effectively identical policy already exists
//
// Detection NEVER auto-resolves. It records PolicyConflict rows for reviewers.
// The deterministic runtime resolver (policy-resolver.ts) still resolves at
// query time via priority/specificity/conflictGroup — conflict detection is the
// governance-time early warning.
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

/** Do two scopes overlap on every constrained dimension? */
export function scopesOverlap(a: PolicyScope, b: PolicyScope): boolean {
  const dims: (keyof PolicyScope)[] = [
    "propertyIds",
    "departmentIds",
    "userRoleIds",
    "languages",
    "documentTypeIds",
  ];
  for (const d of dims) {
    const av = a[d] as string[] | null | undefined;
    const bv = b[d] as string[] | null | undefined;
    // If both constrain the dimension and share no value, they don't overlap.
    if (av?.length && bv?.length) {
      if (!av.some((x) => bv.includes(x))) return false;
    }
  }
  return true;
}

interface DetectInput {
  policyType: KnowledgePolicy["policyType"];
  scope: PolicyScope;
  matchConditions: KnowledgePolicy["matchConditions"];
  actions: KnowledgePolicy["actions"];
  term?: string | null;
}

/**
 * Detect conflicts of a candidate (proposal draft or policy) against the set of
 * currently-active policies. Pure function — returns descriptors, does not
 * persist.
 */
export function detectConflictsAgainst(
  candidate: DetectInput,
  activePolicies: KnowledgePolicy[]
): { conflictType: ConflictType; severity: ConflictSeverity; policyId: string; description: string }[] {
  const found: {
    conflictType: ConflictType;
    severity: ConflictSeverity;
    policyId: string;
    description: string;
  }[] = [];

  const cTerm = (
    candidate.term ??
    candidate.actions.canonicalTerm ??
    candidate.matchConditions.terms?.[0] ??
    ""
  )
    .trim()
    .toLowerCase();
  const cMeaning = candidate.actions.canonicalMeaning?.trim().toLowerCase();
  const cBoost = new Set(candidate.actions.boostDocumentIds ?? []);
  const cDemote = new Set(candidate.actions.demoteDocumentIds ?? []);
  const cExclude = new Set(candidate.actions.excludeDocumentIds ?? []);
  const cPrefer = new Set(candidate.actions.preferDocumentIds ?? []);

  for (const p of activePolicies) {
    if (!scopesOverlap(candidate.scope, p.scope ?? {})) continue;

    const pTerm = (
      p.actions?.canonicalTerm ??
      p.matchConditions?.terms?.[0] ??
      ""
    )
      .trim()
      .toLowerCase();
    const pMeaning = p.actions?.canonicalMeaning?.trim().toLowerCase();

    // contradictory_term_mapping
    if (cTerm && pTerm && cTerm === pTerm && cMeaning && pMeaning && cMeaning !== pMeaning) {
      found.push({
        conflictType: "contradictory_term_mapping",
        severity: "high",
        policyId: p.id,
        description: `Term "${cTerm}" already maps to "${pMeaning}" (policy ${p.id}); candidate maps it to "${cMeaning}".`,
      });
    }

    // duplicate_policy (same term + same meaning)
    if (cTerm && pTerm && cTerm === pTerm && cMeaning && pMeaning && cMeaning === pMeaning) {
      found.push({
        conflictType: "duplicate_policy",
        severity: "low",
        policyId: p.id,
        description: `An active policy (${p.id}) already maps "${cTerm}" to the same meaning.`,
      });
    }

    const pBoost = new Set(p.actions?.boostDocumentIds ?? []);
    const pDemote = new Set(p.actions?.demoteDocumentIds ?? []);
    const pExclude = new Set(p.actions?.excludeDocumentIds ?? []);
    const pPrefer = new Set(p.actions?.preferDocumentIds ?? []);

    // boost_and_demote_same_source
    for (const d of cBoost) {
      if (pDemote.has(d)) {
        found.push({
          conflictType: "boost_and_demote_same_source",
          severity: "medium",
          policyId: p.id,
          description: `Candidate boosts ${d} but policy ${p.id} demotes it.`,
        });
      }
    }
    for (const d of cDemote) {
      if (pBoost.has(d)) {
        found.push({
          conflictType: "boost_and_demote_same_source",
          severity: "medium",
          policyId: p.id,
          description: `Candidate demotes ${d} but policy ${p.id} boosts it.`,
        });
      }
    }

    // exclusion_conflict
    for (const d of cExclude) {
      if (pBoost.has(d) || pPrefer.has(d)) {
        found.push({
          conflictType: "exclusion_conflict",
          severity: "high",
          policyId: p.id,
          description: `Candidate excludes ${d} but policy ${p.id} boosts/prefers it.`,
        });
      }
    }
    for (const d of cBoost) {
      if (pExclude.has(d)) {
        found.push({
          conflictType: "exclusion_conflict",
          severity: "high",
          policyId: p.id,
          description: `Candidate boosts ${d} but policy ${p.id} excludes it.`,
        });
      }
    }

    // version_preference_conflict
    if (
      candidate.policyType === "document_version_preference" &&
      p.policyType === "document_version_preference"
    ) {
      const cLatest = candidate.actions.preferLatestVersion === true;
      const pLatest = p.actions?.preferLatestVersion === true;
      const cPref = [...cPrefer];
      const pPref = [...pPrefer];
      const contradicts =
        (cLatest && pPref.length && !pLatest) ||
        (pLatest && cPref.length && !cLatest) ||
        (cPref.length && pPref.length && !cPref.some((x) => pPref.includes(x)));
      if (contradicts) {
        found.push({
          conflictType: "version_preference_conflict",
          severity: "medium",
          policyId: p.id,
          description: `Conflicting version preference with policy ${p.id}.`,
        });
      }
    }
  }

  return found;
}

/**
 * Run detection for a proposal and PERSIST any PolicyConflict rows. Also stamps
 * the proposal's conflictPolicyIds (caller may re-save). Returns the persisted
 * conflicts.
 */
export async function detectAndRecordForProposal(
  proposal: CorrectionProposal
): Promise<PolicyConflict[]> {
  const active = await listActivePolicies(proposal.tenantId);
  const hits = detectConflictsAgainst(
    {
      policyType: proposal.proposalType,
      scope: proposal.suggestedScope,
      matchConditions: proposal.suggestedPolicy.matchConditions,
      actions: proposal.suggestedPolicy.actions,
      term: proposal.term,
    },
    active
  );
  if (!hits.length) return [];

  const col = await getPolicyConflictsCollection();
  const out: PolicyConflict[] = [];
  for (const h of hits) {
    const id = newId("CFL");
    const conflict: PolicyConflict = {
      _id: id,
      id,
      tenantId: proposal.tenantId,
      conflictType: h.conflictType,
      policyIds: [h.policyId],
      proposalIds: [proposal.id],
      description: h.description,
      severity: h.severity,
      status: "open",
      resolutionNotes: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: nowIso(),
    };
    await col.insertOne(conflict as any);
    out.push(conflict);
  }
  return out;
}

export async function listConflicts(
  tenantId = env.defaultTenantId,
  status?: PolicyConflict["status"]
): Promise<PolicyConflict[]> {
  const col = await getPolicyConflictsCollection();
  const q: Record<string, unknown> = { tenantId };
  if (status) q.status = status;
  return col.find(q).sort({ createdAt: -1 }).toArray();
}

export async function resolveConflict(
  id: string,
  resolvedBy: string,
  status: "resolved" | "ignored",
  resolutionNotes?: string
): Promise<void> {
  const col = await getPolicyConflictsCollection();
  await col.updateOne(
    { id },
    {
      $set: {
        status,
        resolvedBy,
        resolvedAt: nowIso(),
        resolutionNotes: resolutionNotes ?? null,
      },
    }
  );
}
