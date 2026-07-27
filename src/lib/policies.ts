import {
  getFeedbackCollection,
  getProposalsCollection,
  getPoliciesCollection,
  CorrectionFeedback,
  CorrectionProposal,
  KnowledgePolicy,
  PolicyStatus,
  PolicyType,
} from "./mongo";
import { env } from "./env";

// ---------------------------------------------------------------------------
// Knowledge Policy Layer — persistence, versioning & lifecycle.
//
// This module owns the DATA operations for the governed layer:
//   - CorrectionFeedback  (raw human feedback)
//   - CorrectionProposal  (AI/human drafts awaiting review)
//   - KnowledgePolicy     (approved, versioned, deterministic policies)
//
// It intentionally does NOT decide *how* a policy affects a query — that is the
// job of the PolicyResolver (policy-resolver.ts). Approved policies are the
// source of truth; this module just stores them, versions them, and toggles
// their lifecycle in an auditable, reversible way.
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ===========================================================================
// CorrectionFeedback
// ===========================================================================

export async function addFeedback(
  input: Omit<CorrectionFeedback, "_id" | "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }
): Promise<CorrectionFeedback> {
  const col = await getFeedbackCollection();
  const id = input.id ?? newId("FB");
  const doc: CorrectionFeedback = {
    _id: id,
    id,
    tenantId: input.tenantId ?? env.defaultTenantId,
    propertyId: input.propertyId ?? null,
    department: input.department ?? null,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    queryText: input.queryText,
    answerText: input.answerText ?? null,
    retrievedDocumentIds: input.retrievedDocumentIds ?? null,
    feedbackType: input.feedbackType,
    feedbackText: input.feedbackText,
    language: input.language ?? null,
    processedAt: input.processedAt ?? null,
    createdAt: input.createdAt ?? nowIso(),
  };
  await col.insertOne(doc as any);
  return doc;
}

export async function listFeedback(
  tenantId = env.defaultTenantId
): Promise<CorrectionFeedback[]> {
  const col = await getFeedbackCollection();
  return col.find({ tenantId }).sort({ createdAt: -1 }).toArray();
}

export async function getFeedback(
  id: string
): Promise<CorrectionFeedback | null> {
  const col = await getFeedbackCollection();
  return col.findOne({ id });
}

export async function markFeedbackProcessed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const col = await getFeedbackCollection();
  await col.updateMany(
    { id: { $in: ids } },
    { $set: { processedAt: nowIso() } }
  );
}

// ===========================================================================
// CorrectionProposal
// ===========================================================================

export async function saveProposal(
  proposal: CorrectionProposal
): Promise<CorrectionProposal> {
  const col = await getProposalsCollection();
  await col.replaceOne({ id: proposal.id }, proposal as any, { upsert: true });
  return proposal;
}

export async function listProposals(
  tenantId = env.defaultTenantId,
  status?: CorrectionProposal["status"]
): Promise<CorrectionProposal[]> {
  const col = await getProposalsCollection();
  const q: Record<string, unknown> = { tenantId };
  if (status) q.status = status;
  return col.find(q).sort({ createdAt: -1 }).toArray();
}

export async function getProposal(
  id: string
): Promise<CorrectionProposal | null> {
  const col = await getProposalsCollection();
  return col.findOne({ id });
}

export async function updateProposal(
  id: string,
  patch: Partial<CorrectionProposal>
): Promise<CorrectionProposal | null> {
  const col = await getProposalsCollection();
  await col.updateOne(
    { id },
    { $set: { ...patch, updatedAt: nowIso() } }
  );
  return getProposal(id);
}

export async function rejectProposal(
  id: string,
  reviewedBy: string,
  reviewNotes?: string
): Promise<CorrectionProposal | null> {
  return updateProposal(id, {
    status: "rejected",
    reviewedBy,
    reviewedAt: nowIso(),
    reviewNotes: reviewNotes ?? null,
  });
}

// ===========================================================================
// KnowledgePolicy
// ===========================================================================

/**
 * Compute a specificity score for a scope — used alongside `priority` for
 * deterministic conflict resolution. More constrained scope = more specific.
 */
export function scopeSpecificity(p: KnowledgePolicy): number {
  const s = p.scope ?? {};
  let n = 0;
  if (s.propertyIds?.length) n += 4;
  if (s.departmentIds?.length) n += 3;
  if (s.userRoleIds?.length) n += 2;
  if (s.languages?.length) n += 1;
  if (s.documentTypeIds?.length) n += 1;
  return n;
}

/**
 * Approve a proposal into an active KnowledgePolicy. This is the ONLY path from
 * "AI suggestion" to "authoritative runtime behaviour" — it always requires an
 * approver. When a prior active policy targets the same conflictGroup, the old
 * one is superseded (kept for audit, not deleted).
 */
export async function approveProposalToPolicy(
  proposal: CorrectionProposal,
  approvedBy: string,
  overrides?: {
    name?: string;
    conflictGroup?: string | null;
    priority?: number;
  }
): Promise<KnowledgePolicy> {
  const col = await getPoliciesCollection();
  const id = newId("POL");
  const conflictGroup =
    overrides?.conflictGroup !== undefined
      ? overrides.conflictGroup
      : defaultConflictGroup(proposal);

  // Supersede any active policy in the same conflict group (versioning).
  let version = 1;
  if (conflictGroup) {
    const prior = await col
      .find({
        tenantId: proposal.tenantId,
        conflictGroup,
        status: "active",
      })
      .sort({ version: -1 })
      .toArray();
    if (prior.length) {
      version = (prior[0].version ?? 0) + 1;
      await col.updateMany(
        {
          tenantId: proposal.tenantId,
          conflictGroup,
          status: "active",
        },
        {
          $set: {
            status: "superseded" as PolicyStatus,
            supersededByPolicyId: id,
            updatedAt: nowIso(),
          },
        }
      );
    }
  }

  const policy: KnowledgePolicy = {
    _id: id,
    id,
    tenantId: proposal.tenantId,
    policyType: proposal.proposalType,
    status: "active",
    version,
    name:
      overrides?.name ??
      proposal.description ??
      `${proposal.proposalType} policy`,
    description: proposal.description,
    scope: proposal.suggestedScope,
    matchConditions: proposal.suggestedPolicy.matchConditions,
    actions: proposal.suggestedPolicy.actions,
    priority:
      overrides?.priority ??
      proposal.suggestedPolicy.priority ??
      defaultPriority(proposal.proposalType),
    conflictGroup: conflictGroup ?? null,
    createdFromProposalId: proposal.id,
    approvedBy,
    approvedAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await col.insertOne(policy as any);

  // Mark the proposal approved and link it to the policy.
  await updateProposal(proposal.id, {
    status: "approved",
    reviewedBy: approvedBy,
    reviewedAt: nowIso(),
    approvedPolicyId: id,
  });

  return policy;
}

/** Directly create an active policy (used by seed/migration/manual admin). */
export async function createPolicy(
  input: Omit<
    KnowledgePolicy,
    "_id" | "id" | "createdAt" | "updatedAt" | "approvedAt" | "version"
  > & { id?: string; version?: number }
): Promise<KnowledgePolicy> {
  const col = await getPoliciesCollection();
  const id = input.id ?? newId("POL");
  const policy: KnowledgePolicy = {
    _id: id,
    id,
    version: input.version ?? 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    approvedAt: nowIso(),
    ...input,
  } as KnowledgePolicy;
  await col.replaceOne({ id }, policy as any, { upsert: true });
  return policy;
}

export async function listActivePolicies(
  tenantId = env.defaultTenantId
): Promise<KnowledgePolicy[]> {
  const col = await getPoliciesCollection();
  return col
    .find({ tenantId, status: "active" })
    .sort({ priority: -1, updatedAt: -1 })
    .toArray();
}

export async function listPolicies(
  tenantId = env.defaultTenantId,
  status?: PolicyStatus
): Promise<KnowledgePolicy[]> {
  const col = await getPoliciesCollection();
  const q: Record<string, unknown> = { tenantId };
  if (status) q.status = status;
  return col.find(q).sort({ updatedAt: -1 }).toArray();
}

export async function getPolicy(id: string): Promise<KnowledgePolicy | null> {
  const col = await getPoliciesCollection();
  return col.findOne({ id });
}

/**
 * Deactivate a policy (reversible rollback). Records who/when/why for audit.
 * The policy is not deleted — it can be re-activated.
 */
export async function deactivatePolicy(
  id: string,
  deactivatedBy: string,
  reason?: string
): Promise<void> {
  const col = await getPoliciesCollection();
  await col.updateOne(
    { id },
    {
      $set: {
        status: "inactive" as PolicyStatus,
        deactivatedBy,
        deactivatedAt: nowIso(),
        deactivationReason: reason ?? null,
        updatedAt: nowIso(),
      },
    }
  );
}

export async function reactivatePolicy(id: string): Promise<void> {
  const col = await getPoliciesCollection();
  await col.updateOne(
    { id },
    {
      $set: {
        status: "active" as PolicyStatus,
        deactivatedBy: null,
        deactivatedAt: null,
        deactivationReason: null,
        updatedAt: nowIso(),
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default runtime priority by policy type (higher wins). */
export function defaultPriority(type: PolicyType): number {
  switch (type) {
    case "document_exclusion":
      return 100; // exclusions are strongest
    case "terminology_mapping":
      return 80;
    case "document_version_preference":
      return 70;
    case "source_boost":
    case "source_demotion":
      return 60;
    case "query_expansion":
      return 50;
    case "intent_mapping":
      return 40;
    case "answer_instruction":
      return 30;
    default:
      return 10;
  }
}

/**
 * A stable conflict group so a later approval on the same subject supersedes
 * the earlier one (rather than both applying). For terminology this is the
 * term; for source/version it is the primary docId.
 */
export function defaultConflictGroup(
  p: CorrectionProposal
): string | null {
  const t = p.proposalType;
  if (t === "terminology_mapping" || t === "query_expansion") {
    const term = (p.term ?? p.suggestedPolicy.matchConditions.terms?.[0] ?? "")
      .trim()
      .toLowerCase();
    return term ? `term:${term}` : null;
  }
  if (
    t === "source_boost" ||
    t === "source_demotion" ||
    t === "document_version_preference" ||
    t === "document_exclusion"
  ) {
    const doc =
      p.suggestedPolicy.actions.boostDocumentIds?.[0] ??
      p.suggestedPolicy.actions.demoteDocumentIds?.[0] ??
      p.suggestedPolicy.actions.excludeDocumentIds?.[0] ??
      p.suggestedPolicy.actions.preferDocumentIds?.[0] ??
      p.suggestedPolicy.matchConditions.documentIds?.[0] ??
      "";
    return doc ? `source:${doc}` : null;
  }
  return null;
}
