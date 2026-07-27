# Knowledge Policy Layer

> The governed, human-approved correction layer that replaces the old
> "rule-based" feedback correction concept.

## Why this is a Knowledge Policy Layer, not a static rule engine

A static rule engine bakes business knowledge into hard-coded `if/else` logic
or a flat table that engineers edit and redeploy. That model has three failure
modes for a property-operations assistant:

1. **It cannot learn from operators.** Every new term (`關水喉`), alias, or
   ranking preference needs an engineer.
2. **It is opaque.** When the assistant behaves oddly, there is no per-query
   record of *which* rule fired and *why*.
3. **It is unsafe to change.** Editing a live rule has no review, no impact
   preview, no rollback, and no scoping — a fix for one property leaks to all.

We also explicitly reject the opposite extreme — a **fully AI-dynamic** system
where the LLM re-decides, at runtime, what an approved business term means. That
is non-deterministic, unauditable, and lets prompt drift silently override
governed knowledge.

The Knowledge Policy Layer is the middle path:

| Concern | Static rule engine | Fully AI-dynamic | **Knowledge Policy Layer** |
| --- | --- | --- | --- |
| Who proposes changes | engineers | the LLM, live | AI **or** humans (proposals) |
| Who authorizes | deploy | nobody | **human approval required** |
| Runtime behaviour | deterministic | non-deterministic | **deterministic** |
| Business knowledge lives in | code | the prompt/model | **policy records (data)** |
| Explainable per query | no | no | **yes (traces)** |
| Scoped | rarely | no | **yes, narrow-first** |
| Reversible | redeploy | no | **yes (deactivate)** |
| Versioned | git | no | **yes (policy version)** |
| Impact preview | no | no | **yes (simulation)** |

**Core principle:** *AI assists; humans govern; the runtime applies approved
policy deterministically.* Approved policy is the single source of truth. The
LLM consumes approved canonical meanings — it never re-invents them at query
time.

## Entities

```
CorrectionFeedback   raw human feedback (bad answer / ranking / term)
        │  AI-assisted (proposal-engine.ts) — advisory only
        ▼
CorrectionProposal   draft awaiting review (status: pending_review)
        │  ├─ conflict-detection.ts   (advisory PolicyConflict rows)
        │  └─ impact-simulation.ts    (PolicyImpactSimulation before approval)
        │  human approves (policies.approveProposalToPolicy)
        ▼
KnowledgePolicy      approved, scoped, versioned, deterministic (status: active)
        │  applied at query time (policy-resolver.ts) inside runSearchEnhanced
        ▼
PolicyApplicationTrace   per-query audit of what applied and how
```

| Entity | Collection | Module |
| --- | --- | --- |
| `CorrectionFeedback` | `correction_feedback` | `policies.ts` |
| `CorrectionProposal` | `correction_proposals` | `proposal-engine.ts`, `policies.ts` |
| `KnowledgePolicy` | `knowledge_policies` | `policies.ts`, `policy-resolver.ts` |
| `PolicyApplicationTrace` | `policy_application_traces` | `policy-trace.ts` |
| `PolicyConflict` | `policy_conflicts` | `conflict-detection.ts` |
| `PolicyImpactSimulation` | `policy_impact_simulations` | `impact-simulation.ts` |

All types are defined in `src/lib/mongo.ts`. Collection names are overridable via
env (see `src/lib/env.ts`).

## Runtime flow (deterministic)

`runSearchEnhanced` (`src/lib/retrieval.ts`) and `runRag` (`src/lib/rag.ts`)
call the `PolicyResolver`:

1. **Query understanding** — language/property/department/role/intent may be
   detected with AI assistance and passed in as `QueryContext`. This is
   advisory input; it does not change how approved policies are applied.
2. **Policy matching** (`resolvePolicies`) — load active policies for the
   tenant, gate by **scope** (`scopeMatches`) then **match conditions**
   (`matchConditions`: terms / aliases / intents / regex patterns / docIds).
3. **Conflict resolution** (`resolveConflicts`) — deterministic ordering:
   `priority DESC → scopeSpecificity DESC → version DESC → id ASC`. Within a
   `conflictGroup` only the strongest survives.
4. **Retrieval planning** — `aggregateActions` produces one plan: query
   expansion, source boost/demote/exclude, prefer-version, rerank deltas, and
   authoritative term meanings. The **original query is always preserved**;
   expansions are appended (`buildExpandedQuery`).
5. **Retrieval + reranking** — hybrid `$rankFusion` (or rerank) runs on the
   expanded query; `applyPolicyPlanToHits` deterministically drops excluded
   docs and reorders boosted/preferred/demoted docs, applying rerank deltas.
6. **Answer generation** — `rag.ts` injects approved term meanings and answer
   instructions as **authoritative** grounding; the system prompt forbids the
   LLM from overriding them.
7. **Trace** — `recordTrace` writes a `PolicyApplicationTrace` describing
   applied/skipped policies, detected terms, expansion, and adjustments.

Determinism guarantee: for the same query + `QueryContext` + active policy set +
document index, the resolved plan is identical run-to-run (unit-tested).

## AI-assisted proposal workflow

`generateProposalsFromFeedback` (`src/lib/proposal-engine.ts`):

1. User submits feedback → stored as `CorrectionFeedback`.
2. AI analyzes it and drafts a `CorrectionProposal` with `proposalType`, `term`,
   `canonicalMeaning`, aliases/expansions, **narrow-first** suggested scope,
   `rationale`, and `confidenceScore`.
   - **LLM path** when an LLM is configured (structured JSON prompt, temp 0).
   - **Deterministic heuristic fallback** otherwise (keyword rules + a
     bilingual maintenance lexicon), so tests and offline demos work and the
     `關水喉` scenario is always covered.
3. Conflict detection runs (advisory `PolicyConflict` rows).
4. Impact simulation can run against sample/historical queries.
5. A human **approves / edits / rejects**. Approval is the only path to an
   active policy and always requires an approver
   (`AUTO_APPROVE_AI_PROPOSALS=false` by default).
6. Runtime applies active policies deterministically; every application is
   traced.

## The `關水喉` example (end to end)

Feedback: *"No, 關水喉 here means shutting the water supply valve, not closing
the faucet."*

Proposal (drafted):

- `proposalType: terminology_mapping`
- `term: 關水喉`, `canonicalMeaning: shut or isolate the water supply valve`
- aliases: `關水掣, 關閉供水閥, shut water supply valve, isolate water supply,
  close stopcock, shut riser valve`
- scope: `propertyId: grand-yoho`, `department: maintenance`,
  `languages: [zh-Hant, en]`
- `status: pending_review`

Approved policy: active `terminology_mapping`, scoped, `conflictGroup:
term:關水喉`, `matchConditions.terms = [關水喉]`, actions carry the canonical
meaning + `expandQueryWith`.

Runtime for query *"tenant says need 關水喉 for renovation"* (property
`grand-yoho`, dept `maintenance`): detects `關水喉` → expands with *isolate water
supply / shut water supply valve* → boosts plumbing SOPs → grounds the answer in
the approved meaning → writes a `PolicyApplicationTrace`.

Reproduce it: `npm run seed-policies`, then run the query in **Compare** / **RAG
Q&A**. Automated coverage: `npm run test:integration` (live Atlas).

## Terminology / naming migration

| Old concept | New name |
| --- | --- |
| Rule | `KnowledgePolicy` |
| RuleEngine | `PolicyResolver` (`resolvePolicies`) |
| RuleEvaluation | `PolicyApplicationTrace` |
| RuleSuggestion | `CorrectionProposal` |
| UserCorrection | `CorrectionFeedback` (+ legacy shim) |
| RuleConflict | `PolicyConflict` |
| RuleSimulation | `PolicyImpactSimulation` |

The legacy `UserCorrection` model in `user_corrections` is **deprecated but
retained**. `runSearchEnhanced` still applies it as a secondary overlay so
existing data keeps working. `correctionToPolicy` (`src/lib/corrections.ts`)
maps old records to the new model; run `npm run migrate-policies` to convert
active corrections into scoped policies (then narrow their scope in review).

## API surface

| Route | Purpose |
| --- | --- |
| `POST/GET /api/feedback` | submit/list feedback (POST also drafts a proposal) |
| `GET /api/proposals`, `POST` `{action: approve\|reject\|edit}` | review proposals |
| `GET/POST /api/policies`, `PATCH` `{action: deactivate\|reactivate}` | manage/rollback policies |
| `GET/POST /api/conflicts` | list/resolve conflicts |
| `GET/POST /api/simulations` | list/run impact simulations |
| `GET /api/traces` | audit runtime policy applications |
| `POST /api/search`, `/api/rag` | now accept `policyContext`, return `policyPlan` + `traceId` |

## Design principles (checklist)

- Human-approved policy is the source of truth.
- AI proposals are never auto-active (`AUTO_APPROVE_AI_PROPOSALS=false`).
- Policies are scoped; prefer narrow (tenant + property + department + language).
- Every active policy is explainable, auditable, versioned, and reversible.
- No business terms hard-coded in application logic — knowledge lives in policy
  records.
- Runtime is deterministic given the same query, metadata, policy set, and
  index.
- Multilingual (Traditional Chinese + English) and property-specific terms are
  first-class.
- Feedback, proposal, approved policy, runtime trace, conflict, and impact
  simulation are distinct entities.
```
