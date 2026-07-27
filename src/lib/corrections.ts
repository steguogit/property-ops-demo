import {
  getCorrectionsCollection,
  UserCorrection,
  CorrectionType,
  KnowledgePolicy,
  PolicyType,
  PolicyScope,
  PolicyMatchConditions,
  PolicyActions,
} from "./mongo";
import { defaultPriority, defaultConflictGroup } from "./policies";
import { env } from "./env";

// ---------------------------------------------------------------------------
// DEPRECATED (Iteration 2): the flat UserCorrection overlay in `user_corrections`.
//
// This module is superseded by the governed Knowledge Policy Layer:
//   - CorrectionFeedback  (src/lib/policies.ts)
//   - CorrectionProposal  (src/lib/proposal-engine.ts)
//   - KnowledgePolicy     (src/lib/policies.ts + policy-resolver.ts)
//
// It is retained so existing data and the legacy CorrectionsTab keep working
// during the transition, and so `runSearchEnhanced` can still apply old
// user_corrections as a secondary overlay. New work should target the policy
// layer. Use `npm run migrate-policies` to convert these records to policies.
// See `correctionToPolicy` at the bottom of this file for the mapping.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Human-in-the-loop corrections, applied at the DATA LAYER (never by editing
// prompts). Corrections are stored as documents and consumed by retrieval / RAG
// at query time:
//
//   term_meaning        -> inject the clarified meaning into RAG grounding and
//                          add the term as a boosted exact term.
//   prefer_source       -> pin a docId to the top of results for a query.
//   demote_source       -> push a docId down / drop it for a query.
//   prefer_version      -> prefer a specific document version label.
//   wrong_interpretation-> record that a chunk/answer was misread (audit + can
//                          demote the offending source).
//
// All corrections are reversible (set active=false) and fully explainable —
// the UI can show exactly which corrections shaped a result.
// ---------------------------------------------------------------------------

export interface AppliedCorrections {
  pinnedDocIds: string[];
  demotedDocIds: string[];
  preferredVersionLabels: string[];
  termMeanings: { term: string; meaning: string }[];
  extraBoostTerms: string[];
  /** Human-readable summary lines for the explain modal. */
  applied: { type: CorrectionType; summary: string }[];
}

function matchesScope(c: UserCorrection, query: string): boolean {
  if (!c.query) return true; // global correction
  // Scope match: the correction's query/topic words appear in the live query,
  // or the term appears in the query.
  const q = query.toLowerCase();
  if (c.query && q.includes(c.query.toLowerCase())) return true;
  if (c.term && q.includes(c.term.toLowerCase())) return true;
  return false;
}

export async function getActiveCorrections(): Promise<UserCorrection[]> {
  const col = await getCorrectionsCollection();
  return col.find({ active: true }).sort({ createdAt: -1 }).toArray();
}

/** Compute the corrections that apply to a given query. */
export async function correctionsForQuery(
  query: string
): Promise<AppliedCorrections> {
  const all = await getActiveCorrections();
  const out: AppliedCorrections = {
    pinnedDocIds: [],
    demotedDocIds: [],
    preferredVersionLabels: [],
    termMeanings: [],
    extraBoostTerms: [],
    applied: [],
  };
  for (const c of all) {
    if (!matchesScope(c, query)) continue;
    switch (c.type) {
      case "prefer_source":
        if (c.targetDocId) {
          out.pinnedDocIds.push(c.targetDocId);
          out.applied.push({
            type: c.type,
            summary: `Pinned ${c.targetDocId} as authoritative source`,
          });
        }
        break;
      case "demote_source":
      case "wrong_interpretation":
        if (c.targetDocId) {
          out.demotedDocIds.push(c.targetDocId);
          out.applied.push({
            type: c.type,
            summary:
              c.type === "wrong_interpretation"
                ? `Flagged ${c.targetDocId} as misinterpreted — demoted`
                : `Demoted ${c.targetDocId}`,
          });
        }
        break;
      case "prefer_version":
        if (c.preferredVersionLabel) {
          out.preferredVersionLabels.push(c.preferredVersionLabel);
          out.applied.push({
            type: c.type,
            summary: `Prefer version "${c.preferredVersionLabel}"${
              c.targetDocId ? ` (${c.targetDocId})` : ""
            }`,
          });
        }
        break;
      case "term_meaning":
        if (c.term && c.correctedMeaning) {
          out.termMeanings.push({
            term: c.term,
            meaning: c.correctedMeaning,
          });
          out.extraBoostTerms.push(c.term);
          out.applied.push({
            type: c.type,
            summary: `Term "${c.term}" means: ${c.correctedMeaning}`,
          });
        }
        break;
    }
  }
  return out;
}

/**
 * Apply pin / demote ordering to a ranked list of hits keyed by docId.
 * Pinned docs move to the front (keeping their relative order); demoted docs
 * move to the back. Returns a new array.
 */
export function applyCorrectionOrdering<T extends { docId: string }>(
  hits: T[],
  c: AppliedCorrections
): T[] {
  if (!c.pinnedDocIds.length && !c.demotedDocIds.length) return hits;
  const pinned = new Set(c.pinnedDocIds);
  const demoted = new Set(c.demotedDocIds);
  const head: T[] = [];
  const mid: T[] = [];
  const tail: T[] = [];
  for (const h of hits) {
    if (pinned.has(h.docId)) head.push(h);
    else if (demoted.has(h.docId)) tail.push(h);
    else mid.push(h);
  }
  return [...head, ...mid, ...tail];
}

/** Build a grounding-context block from term-meaning corrections for RAG. */
export function correctionsContextBlock(c: AppliedCorrections): string {
  if (!c.termMeanings.length) return "";
  const lines = c.termMeanings.map(
    (t) => `- "${t.term}" means: ${t.meaning}`
  );
  return (
    "Human-reviewed term clarifications (authoritative, apply these):\n" +
    lines.join("\n")
  );
}

export async function addCorrection(
  input: Omit<UserCorrection, "_id" | "correctionId" | "createdAt" | "active"> & {
    active?: boolean;
  }
): Promise<UserCorrection> {
  const col = await getCorrectionsCollection();
  const correctionId = `COR-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const doc: UserCorrection = {
    _id: correctionId,
    correctionId,
    active: input.active ?? true,
    createdAt: new Date().toISOString(),
    ...input,
  };
  await col.insertOne(doc as any);
  return doc;
}

export async function setCorrectionActive(
  correctionId: string,
  active: boolean
): Promise<void> {
  const col = await getCorrectionsCollection();
  await col.updateOne({ correctionId }, { $set: { active } });
}

export async function listCorrections(): Promise<UserCorrection[]> {
  const col = await getCorrectionsCollection();
  return col.find({}).sort({ createdAt: -1 }).toArray();
}

// ---------------------------------------------------------------------------
// Migration shim: legacy UserCorrection -> governed KnowledgePolicy.
//
// Maps the old flat correction types onto the new policy model so existing
// reviewer decisions are preserved as scoped, versioned, auditable policies.
// Used by scripts/migrate-corrections-to-policies.ts.
// ---------------------------------------------------------------------------

const CORRECTION_TYPE_TO_POLICY_TYPE: Record<CorrectionType, PolicyType> = {
  term_meaning: "terminology_mapping",
  prefer_source: "source_boost",
  demote_source: "source_demotion",
  prefer_version: "document_version_preference",
  wrong_interpretation: "source_demotion",
};

/**
 * Convert a legacy UserCorrection into an approved-KnowledgePolicy shape (minus
 * the persistence-only fields the caller fills in). Scope is intentionally
 * global (no property/department) because the legacy model had no such context;
 * a reviewer should narrow it after migration.
 */
export function correctionToPolicy(
  c: UserCorrection,
  approvedBy = "migration"
): Omit<KnowledgePolicy, "_id" | "id" | "createdAt" | "updatedAt" | "approvedAt" | "version"> {
  const policyType = CORRECTION_TYPE_TO_POLICY_TYPE[c.type];

  const matchConditions: PolicyMatchConditions = {};
  const actions: PolicyActions = {};

  if (c.query) matchConditions.queryPatterns = [c.query];

  switch (c.type) {
    case "term_meaning":
      if (c.term) {
        matchConditions.terms = [c.term];
        actions.canonicalTerm = c.term;
        actions.canonicalMeaning = c.correctedMeaning ?? null;
        actions.expandQueryWith = c.term ? [c.term] : null;
      }
      break;
    case "prefer_source":
      if (c.targetDocId) actions.boostDocumentIds = [c.targetDocId];
      break;
    case "demote_source":
    case "wrong_interpretation":
      if (c.targetDocId) actions.demoteDocumentIds = [c.targetDocId];
      break;
    case "prefer_version":
      actions.preferLatestVersion = true;
      if (c.preferredVersionLabel) {
        matchConditions.metadataFilters = {
          versionLabel: c.preferredVersionLabel,
        };
      }
      break;
  }

  const scope: PolicyScope = {
    propertyIds: c.propertyName ? [c.propertyName] : null,
    departmentIds: null,
    userRoleIds: null,
    languages: null,
    documentTypeIds: null,
    effectiveFrom: null,
    effectiveUntil: null,
  };

  // Reuse the proposal-based conflictGroup logic by constructing a minimal
  // proposal-like object.
  const conflictGroup = defaultConflictGroup({
    proposalType: policyType,
    term: c.term ?? null,
    suggestedPolicy: { matchConditions, actions },
  } as any);

  return {
    tenantId: env.defaultTenantId,
    policyType,
    status: "active",
    name: `Migrated: ${c.type}${c.term ? ` (${c.term})` : ""}`,
    description:
      c.note ?? `Migrated from legacy correction ${c.correctionId}`,
    scope,
    matchConditions,
    actions,
    priority: defaultPriority(policyType),
    conflictGroup: conflictGroup ?? null,
    createdFromProposalId: null,
    approvedBy,
  };
}
