import {
  KnowledgePolicy,
  PolicyScope,
  PolicyActions,
} from "./mongo";
import { listActivePolicies, scopeSpecificity } from "./policies";
import { env } from "./env";

// ---------------------------------------------------------------------------
// PolicyResolver (formerly the "rule engine").
//
// DETERMINISTIC. Given the same query + metadata + policy-set, this always
// produces the same resolution. No LLM is consulted here. Approved policies are
// the source of truth; the resolver only reads them and computes which apply
// and how.
//
// Pipeline:
//   1. load active policies for the tenant
//   2. filter by scope (property / department / role / language / doc-type /
//      effective dates)
//   3. filter by match conditions (terms / aliases / intents / query patterns)
//   4. resolve conflicts deterministically (priority -> specificity -> version)
//   5. aggregate the surviving policies' actions into a single plan
// ---------------------------------------------------------------------------

export interface QueryContext {
  tenantId?: string;
  propertyId?: string | null;
  departmentId?: string | null;
  userRoleId?: string | null;
  language?: string | null;
  documentTypeId?: string | null;
  /** Intents detected by query understanding (AI-assisted, non-authoritative). */
  intents?: string[];
  /** ISO timestamp used for effectiveFrom/effectiveUntil checks (default now). */
  at?: string;
}

export interface ResolvedPolicyPlan {
  appliedPolicies: KnowledgePolicy[];
  skippedPolicyIds: string[];
  detectedTerms: string[];
  /** The union of query-expansion tokens contributed by matched policies. */
  expandQueryWith: string[];
  /** Term -> canonical meaning, for answer grounding (authoritative). */
  termMeanings: { term: string; meaning: string }[];
  boostDocumentIds: string[];
  demoteDocumentIds: string[];
  excludeDocumentIds: string[];
  preferDocumentIds: string[];
  preferLatestVersion: boolean;
  /** docId -> net rerank delta (boost positive, penalty negative). */
  rerankDeltas: Record<string, number>;
  answerInstructions: string[];
}

function lc(s: string): string {
  return s.toLowerCase();
}

/** Scope gate: does this policy apply to the given query context? */
export function scopeMatches(
  scope: PolicyScope,
  ctx: QueryContext
): boolean {
  const atMs = new Date(ctx.at ?? new Date().toISOString()).getTime();

  if (scope.effectiveFrom) {
    if (atMs < new Date(scope.effectiveFrom).getTime()) return false;
  }
  if (scope.effectiveUntil) {
    if (atMs > new Date(scope.effectiveUntil).getTime()) return false;
  }
  // A non-empty scope dimension acts as an allow-list. Empty/null = any.
  if (
    scope.propertyIds?.length &&
    (!ctx.propertyId || !scope.propertyIds.includes(ctx.propertyId))
  ) {
    return false;
  }
  if (
    scope.departmentIds?.length &&
    (!ctx.departmentId || !scope.departmentIds.includes(ctx.departmentId))
  ) {
    return false;
  }
  if (
    scope.userRoleIds?.length &&
    (!ctx.userRoleId || !scope.userRoleIds.includes(ctx.userRoleId))
  ) {
    return false;
  }
  if (
    scope.languages?.length &&
    (!ctx.language || !scope.languages.includes(ctx.language))
  ) {
    return false;
  }
  if (
    scope.documentTypeIds?.length &&
    (!ctx.documentTypeId ||
      !scope.documentTypeIds.includes(ctx.documentTypeId))
  ) {
    return false;
  }
  return true;
}

/**
 * Match conditions gate: which terms/aliases/intents/patterns of this policy
 * are triggered by the query. Returns the matched term strings (empty array =
 * no match, unless the policy has no conditions at all, which means "always").
 */
export function matchConditions(
  policy: KnowledgePolicy,
  query: string,
  ctx: QueryContext
): { matched: boolean; detectedTerms: string[] } {
  const mc = policy.matchConditions ?? {};
  const q = lc(query);
  const detected: string[] = [];

  const hasAnyCondition =
    !!mc.terms?.length ||
    !!mc.aliases?.length ||
    !!mc.intents?.length ||
    !!mc.queryPatterns?.length ||
    !!mc.documentIds?.length;

  // A policy with NO match conditions applies whenever its scope matches.
  // (Kept explicit so this is intentional, not accidental.)
  if (!hasAnyCondition) return { matched: true, detectedTerms: [] };

  for (const t of mc.terms ?? []) {
    if (t && q.includes(lc(t))) detected.push(t);
  }
  for (const a of mc.aliases ?? []) {
    if (a && q.includes(lc(a))) detected.push(a);
  }
  for (const intent of mc.intents ?? []) {
    if (ctx.intents?.includes(intent)) detected.push(`intent:${intent}`);
  }
  for (const pat of mc.queryPatterns ?? []) {
    if (!pat) continue;
    let hit = false;
    try {
      hit = new RegExp(pat, "i").test(query);
    } catch {
      // not a valid regex — treat as substring
      hit = q.includes(lc(pat));
    }
    if (hit) detected.push(`pattern:${pat}`);
  }

  return { matched: detected.length > 0, detectedTerms: detected };
}

/**
 * Deterministic conflict resolution across matched policies. Within a
 * conflictGroup only the strongest survives. Ordering key:
 *   priority DESC -> scopeSpecificity DESC -> version DESC -> id ASC (stable)
 */
export function resolveConflicts(matched: KnowledgePolicy[]): {
  winners: KnowledgePolicy[];
  losers: KnowledgePolicy[];
} {
  const ordered = [...matched].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const sa = scopeSpecificity(a);
    const sb = scopeSpecificity(b);
    if (sb !== sa) return sb - sa;
    if ((b.version ?? 0) !== (a.version ?? 0)) {
      return (b.version ?? 0) - (a.version ?? 0);
    }
    return a.id.localeCompare(b.id);
  });

  const seenGroups = new Set<string>();
  const winners: KnowledgePolicy[] = [];
  const losers: KnowledgePolicy[] = [];
  for (const p of ordered) {
    const g = p.conflictGroup;
    if (g) {
      if (seenGroups.has(g)) {
        losers.push(p);
        continue;
      }
      seenGroups.add(g);
    }
    winners.push(p);
  }
  return { winners, losers };
}

/** Aggregate the winning policies' actions into a single deterministic plan. */
export function aggregateActions(
  winners: KnowledgePolicy[],
  detectedByPolicy: Map<string, string[]>
): Omit<ResolvedPolicyPlan, "appliedPolicies" | "skippedPolicyIds"> {
  const expand = new Set<string>();
  const termMeanings: { term: string; meaning: string }[] = [];
  const boost = new Set<string>();
  const demote = new Set<string>();
  const exclude = new Set<string>();
  const prefer = new Set<string>();
  const rerankDeltas: Record<string, number> = {};
  const answerInstructions: string[] = [];
  const detectedTerms = new Set<string>();
  let preferLatestVersion = false;

  for (const p of winners) {
    const a: PolicyActions = p.actions ?? {};
    (detectedByPolicy.get(p.id) ?? []).forEach((t) => detectedTerms.add(t));

    if (a.canonicalTerm && a.canonicalMeaning) {
      termMeanings.push({
        term: a.canonicalTerm,
        meaning: a.canonicalMeaning,
      });
    }
    for (const e of a.expandQueryWith ?? []) if (e) expand.add(e);
    for (const d of a.boostDocumentIds ?? []) if (d) boost.add(d);
    for (const d of a.demoteDocumentIds ?? []) if (d) demote.add(d);
    for (const d of a.excludeDocumentIds ?? []) if (d) exclude.add(d);
    for (const d of a.preferDocumentIds ?? []) if (d) prefer.add(d);
    if (a.preferLatestVersion) preferLatestVersion = true;

    for (const d of a.boostDocumentIds ?? []) {
      rerankDeltas[d] = (rerankDeltas[d] ?? 0) + (a.rerankBoost ?? 1);
    }
    for (const d of a.demoteDocumentIds ?? []) {
      rerankDeltas[d] = (rerankDeltas[d] ?? 0) - (a.rerankPenalty ?? 1);
    }
    if (a.answerInstruction) answerInstructions.push(a.answerInstruction);
  }

  // Exclusion wins over boost: never boost something we also exclude.
  for (const d of exclude) {
    boost.delete(d);
    prefer.delete(d);
    delete rerankDeltas[d];
  }

  return {
    detectedTerms: [...detectedTerms],
    expandQueryWith: [...expand],
    termMeanings,
    boostDocumentIds: [...boost],
    demoteDocumentIds: [...demote],
    excludeDocumentIds: [...exclude],
    preferDocumentIds: [...prefer],
    preferLatestVersion,
    rerankDeltas,
    answerInstructions,
  };
}

/**
 * The main entry point. Resolve the active policies that apply to a query and
 * produce a deterministic plan. `policies` can be injected (for tests); when
 * omitted, active policies are loaded for the tenant.
 */
export async function resolvePolicies(
  query: string,
  ctx: QueryContext = {},
  policies?: KnowledgePolicy[]
): Promise<ResolvedPolicyPlan> {
  const tenantId = ctx.tenantId ?? env.defaultTenantId;
  const active =
    policies ?? (await listActivePolicies(tenantId));

  const matched: KnowledgePolicy[] = [];
  const detectedByPolicy = new Map<string, string[]>();
  const skipped: string[] = [];

  for (const p of active) {
    // Wrong tenant: not relevant to this query at all — do not record.
    if (p.tenantId !== tenantId) continue;
    // Out of scope or no match-condition hit: record as skipped for the trace.
    if (!scopeMatches(p.scope ?? {}, ctx)) {
      skipped.push(p.id);
      continue;
    }
    const m = matchConditions(p, query, ctx);
    if (m.matched) {
      matched.push(p);
      detectedByPolicy.set(p.id, m.detectedTerms);
    } else {
      skipped.push(p.id);
    }
  }

  const { winners, losers } = resolveConflicts(matched);
  losers.forEach((l) => skipped.push(l.id));

  const agg = aggregateActions(winners, detectedByPolicy);

  return {
    appliedPolicies: winners,
    skippedPolicyIds: skipped,
    ...agg,
  };
}

/** Build the expanded query string (original preserved first). */
export function buildExpandedQuery(
  original: string,
  plan: ResolvedPolicyPlan
): string {
  if (!plan.expandQueryWith.length) return original;
  const extra = plan.expandQueryWith.filter(
    (t) => !lc(original).includes(lc(t))
  );
  return extra.length ? `${original} ${extra.join(" ")}` : original;
}
