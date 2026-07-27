import {
  CorrectionFeedback,
  CorrectionProposal,
  PolicyType,
  PolicyScope,
  PolicyMatchConditions,
  PolicyActions,
  FeedbackType,
} from "./mongo";
import { env, hasLLM } from "./env";
import { llmChat, parseJsonLoose } from "./llm";
import { saveProposal, markFeedbackProcessed, defaultPriority } from "./policies";

// ---------------------------------------------------------------------------
// AI-assisted proposal engine.
//
// This is where AI ADDS VALUE without being authoritative. It reads raw human
// feedback and drafts one or more CorrectionProposal records:
//   - proposalType, term, canonicalMeaning
//   - suggested aliases / query expansions
//   - suggested scope (narrow-first)
//   - rationale + confidenceScore
//
// Every proposal is created as `pending_review`. It NEVER becomes an active
// policy here. A human must approve it (policies.approveProposalToPolicy).
//
// Two paths:
//   1. LLM path (when an LLM is configured): a structured JSON prompt.
//   2. Deterministic heuristic fallback (no LLM / LLM failure): keyword rules
//      incl. a bilingual maintenance-term lexicon. This keeps tests + offline
//      demos working and guarantees the 關水喉 scenario is covered.
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

interface DraftShape {
  proposalType: PolicyType;
  term?: string;
  canonicalMeaning?: string;
  description: string;
  rationale: string;
  confidenceScore: number;
  scope: PolicyScope;
  matchConditions: PolicyMatchConditions;
  actions: PolicyActions;
}

// ---------------------------------------------------------------------------
// Deterministic lexicon for the fallback path.
// Keyed by a term the feedback might reference; provides the canonical meaning
// and the aliases/expansions we would propose. This is the AUTHORITATIVE demo
// example (關水喉) but the mechanism is generic.
// ---------------------------------------------------------------------------
const TERM_LEXICON: Record<
  string,
  { canonicalMeaning: string; aliases: string[]; languages: string[] }
> = {
  關水喉: {
    canonicalMeaning: "shut or isolate the water supply valve",
    aliases: [
      "關水掣",
      "關閉供水閥",
      "shut water supply valve",
      "isolate water supply",
      "close stopcock",
      "shut riser valve",
    ],
    languages: ["zh-Hant", "en"],
  },
  關電源: {
    canonicalMeaning: "isolate the electrical supply at the distribution board",
    aliases: [
      "關電掣",
      "切斷電源",
      "isolate power supply",
      "shut off electricity",
      "trip the breaker",
    ],
    languages: ["zh-Hant", "en"],
  },
};

function feedbackTypeToProposalType(ft: FeedbackType): PolicyType {
  switch (ft) {
    case "wrong_term_interpretation":
      return "terminology_mapping";
    case "missing_document":
      return "query_expansion";
    case "wrong_document_rank":
      return "source_boost";
    case "outdated_document":
      return "document_version_preference";
    case "source_should_be_boosted":
      return "source_boost";
    case "source_should_be_demoted":
      return "source_demotion";
    case "incorrect_answer":
      return "answer_instruction";
    default:
      return "answer_instruction";
  }
}

/** Narrow-first scope derived from the feedback context. */
function scopeFromFeedback(fb: CorrectionFeedback, languages?: string[]): PolicyScope {
  return {
    propertyIds: fb.propertyId ? [fb.propertyId] : null,
    departmentIds: fb.department ? [fb.department] : null,
    userRoleIds: null,
    languages: languages ?? (fb.language ? [fb.language] : null),
    documentTypeIds: null,
    effectiveFrom: null,
    effectiveUntil: null,
  };
}

/** Find a known lexicon term mentioned in the feedback text or query. */
function detectLexiconTerm(fb: CorrectionFeedback): string | null {
  const hay = `${fb.feedbackText} ${fb.queryText}`;
  for (const term of Object.keys(TERM_LEXICON)) {
    if (hay.includes(term)) return term;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------
function heuristicDraft(fb: CorrectionFeedback): DraftShape {
  const proposalType = feedbackTypeToProposalType(fb.feedbackType);

  // Terminology: prefer a lexicon hit for a rich, correct proposal.
  if (proposalType === "terminology_mapping") {
    const term = detectLexiconTerm(fb);
    if (term) {
      const entry = TERM_LEXICON[term];
      return {
        proposalType,
        term,
        canonicalMeaning: entry.canonicalMeaning,
        description: `Terminology mapping for "${term}"`,
        rationale:
          "Feedback indicates a wrong interpretation of a Cantonese / Traditional Chinese maintenance term. Mapping it to the canonical meaning and adding bilingual aliases improves retrieval and grounding.",
        confidenceScore: 0.9,
        scope: scopeFromFeedback(fb, entry.languages),
        matchConditions: {
          terms: [term],
          aliases: entry.aliases,
        },
        actions: {
          canonicalTerm: term,
          canonicalMeaning: entry.canonicalMeaning,
          expandQueryWith: entry.aliases,
        },
      };
    }
    // Unknown term: still draft, but low confidence and no invented meaning.
    return {
      proposalType,
      term: fb.queryText.slice(0, 40),
      canonicalMeaning: undefined,
      description: `Terminology clarification requested (needs reviewer input)`,
      rationale:
        "Feedback flags a wrong term interpretation but the term is not in the known lexicon. A reviewer must supply the canonical meaning and aliases.",
      confidenceScore: 0.3,
      scope: scopeFromFeedback(fb),
      matchConditions: {},
      actions: {},
    };
  }

  // Source boost / demotion / exclusion / version preference.
  const docs = fb.retrievedDocumentIds ?? [];
  if (proposalType === "source_boost") {
    return {
      proposalType,
      description: `Boost source(s) for queries like "${fb.queryText.slice(0, 40)}"`,
      rationale:
        "Feedback indicates the correct document ranked too low or was expected. Boost it for this query scope.",
      confidenceScore: 0.5,
      scope: scopeFromFeedback(fb),
      matchConditions: { queryPatterns: [escapeForPattern(fb.queryText)] },
      actions: { boostDocumentIds: docs, rerankBoost: 1 },
    };
  }
  if (proposalType === "source_demotion") {
    return {
      proposalType,
      description: `Demote source(s) for queries like "${fb.queryText.slice(0, 40)}"`,
      rationale:
        "Feedback indicates a document was surfaced that should rank lower for this query scope.",
      confidenceScore: 0.5,
      scope: scopeFromFeedback(fb),
      matchConditions: { queryPatterns: [escapeForPattern(fb.queryText)] },
      actions: { demoteDocumentIds: docs, rerankPenalty: 1 },
    };
  }
  if (proposalType === "document_version_preference") {
    return {
      proposalType,
      description: `Prefer latest version for "${fb.queryText.slice(0, 40)}"`,
      rationale:
        "Feedback indicates an outdated document was returned. Prefer the latest / current version.",
      confidenceScore: 0.6,
      scope: scopeFromFeedback(fb),
      matchConditions: { queryPatterns: [escapeForPattern(fb.queryText)] },
      actions: { preferLatestVersion: true, preferDocumentIds: docs },
    };
  }
  if (proposalType === "query_expansion") {
    const term = detectLexiconTerm(fb);
    const aliases = term ? TERM_LEXICON[term].aliases : [];
    return {
      proposalType,
      term: term ?? undefined,
      description: `Query expansion for "${fb.queryText.slice(0, 40)}"`,
      rationale:
        "Feedback indicates a relevant document was missing — likely a vocabulary gap. Expand the query with related aliases.",
      confidenceScore: term ? 0.7 : 0.4,
      scope: scopeFromFeedback(fb, term ? TERM_LEXICON[term].languages : undefined),
      matchConditions: term ? { terms: [term] } : {},
      actions: { expandQueryWith: aliases },
    };
  }

  // answer_instruction / other
  return {
    proposalType: "answer_instruction",
    description: `Answer-grounding instruction from feedback`,
    rationale:
      "Feedback about an incorrect answer. Capture a scoped grounding instruction for reviewer approval (does not override retrieval).",
    confidenceScore: 0.4,
    scope: scopeFromFeedback(fb),
    matchConditions: { queryPatterns: [escapeForPattern(fb.queryText)] },
    actions: {
      answerInstruction: fb.feedbackText.slice(0, 400),
    },
  };
}

function escapeForPattern(s: string): string {
  // Use a short, distinctive keyword slice rather than the whole query, and
  // escape regex metacharacters so it is used as a literal substring pattern.
  const kw = s.trim().slice(0, 30);
  return kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------
const LLM_SYSTEM = `You are a knowledge-governance assistant for a property-management retrieval system.
You DO NOT change system behaviour. You only DRAFT correction proposals for a human reviewer to approve or reject.
Given user feedback about a bad answer, ranking, or term interpretation, produce a JSON object describing a proposed correction policy.
Never invent facts. If unsure of a term's meaning, set confidenceScore low and leave canonicalMeaning null.
Prefer NARROW scope (property + department + language) over global.
Support mixed Traditional Chinese (zh-Hant) and English terms.

Return ONLY JSON with this shape:
{
  "proposalType": "terminology_mapping|query_expansion|source_boost|source_demotion|document_version_preference|document_exclusion|intent_mapping|answer_instruction",
  "term": string|null,
  "canonicalMeaning": string|null,
  "description": string,
  "rationale": string,
  "confidenceScore": number,   // 0..1
  "scope": { "propertyIds": string[]|null, "departmentIds": string[]|null, "userRoleIds": string[]|null, "languages": string[]|null, "documentTypeIds": string[]|null },
  "matchConditions": { "terms": string[]|null, "aliases": string[]|null, "intents": string[]|null, "queryPatterns": string[]|null, "documentIds": string[]|null },
  "actions": { "canonicalTerm": string|null, "canonicalMeaning": string|null, "expandQueryWith": string[]|null, "boostDocumentIds": string[]|null, "demoteDocumentIds": string[]|null, "excludeDocumentIds": string[]|null, "preferDocumentIds": string[]|null, "preferLatestVersion": boolean|null, "answerInstruction": string|null }
}`;

async function llmDraft(fb: CorrectionFeedback): Promise<DraftShape | null> {
  const user = `Feedback type: ${fb.feedbackType}
Query: ${fb.queryText}
${fb.answerText ? `Answer given: ${fb.answerText}\n` : ""}${
    fb.retrievedDocumentIds?.length
      ? `Retrieved docIds: ${fb.retrievedDocumentIds.join(", ")}\n`
      : ""
  }Property: ${fb.propertyId ?? "unknown"}
Department: ${fb.department ?? "unknown"}
Language: ${fb.language ?? "unknown"}
Feedback text: ${fb.feedbackText}

Draft ONE correction proposal as JSON.`;

  try {
    const raw = await llmChat(
      [
        { role: "system", content: LLM_SYSTEM },
        { role: "user", content: user },
      ],
      { jsonMode: true, temperature: 0 }
    );
    const parsed = parseJsonLoose<any>(raw);
    if (!parsed || !parsed.proposalType) return null;
    return {
      proposalType: parsed.proposalType,
      term: parsed.term ?? undefined,
      canonicalMeaning: parsed.canonicalMeaning ?? undefined,
      description: parsed.description ?? `${parsed.proposalType} proposal`,
      rationale: parsed.rationale ?? "AI-drafted from user feedback.",
      confidenceScore:
        typeof parsed.confidenceScore === "number"
          ? parsed.confidenceScore
          : 0.5,
      scope: parsed.scope ?? scopeFromFeedback(fb),
      matchConditions: parsed.matchConditions ?? {},
      actions: parsed.actions ?? {},
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate proposal(s) from one feedback record. Always returns pending_review
 * proposals — never activates anything. Uses the LLM when available, otherwise
 * a deterministic heuristic. If `useLlm` is false, forces the heuristic (used
 * by tests for reproducibility).
 */
export async function generateProposalsFromFeedback(
  fb: CorrectionFeedback,
  opts: { useLlm?: boolean; proposedBy?: "ai" | "human" | "system" } = {}
): Promise<CorrectionProposal[]> {
  const useLlm = opts.useLlm ?? hasLLM();

  let draft: DraftShape | null = null;
  let proposedBy: "ai" | "human" | "system" = opts.proposedBy ?? "ai";
  if (useLlm) {
    draft = await llmDraft(fb);
  }
  if (!draft) {
    draft = heuristicDraft(fb);
    if (!opts.proposedBy) proposedBy = "system"; // deterministic, not the LLM
  }

  const id = newId("PROP");
  const proposal: CorrectionProposal = {
    _id: id,
    id,
    tenantId: fb.tenantId,
    sourceFeedbackIds: [fb.id],
    proposalType: draft.proposalType,
    status: "pending_review",
    proposedBy,
    term: draft.term ?? null,
    canonicalMeaning: draft.canonicalMeaning ?? null,
    description: draft.description,
    rationale: draft.rationale,
    confidenceScore: draft.confidenceScore,
    suggestedScope: draft.scope,
    suggestedPolicy: {
      matchConditions: draft.matchConditions,
      actions: draft.actions,
      priority: defaultPriority(draft.proposalType),
    },
    conflictPolicyIds: null,
    impactSimulationId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    approvedPolicyId: null,
  };

  await saveProposal(proposal);
  await markFeedbackProcessed([fb.id]);
  return [proposal];
}
