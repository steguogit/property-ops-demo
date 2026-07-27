You are helping update the current correction/rule-layer design for an AI-powered property management knowledge assistant.

Context:
We previously described the system as having a “rule-based workflow” for feedback corrections. We want to revise this design. The goal is not to build a static rule engine, but a hybrid AI-assisted, human-approved Knowledge Policy Layer.

The system should use AI to interpret feedback, propose corrections, cluster repeated issues, suggest scope, generate query expansion aliases, detect conflicts, and simulate impact. However, approved corrections should be stored as structured policies and applied deterministically at retrieval time for governance, auditability, rollback, and consistency.

Please update the schema, API/design docs, and implementation plan accordingly.

Core design shift:
Replace the concept of a simple “rule layer” with a governed “Knowledge Policy Layer” or “Correction Policy Layer.”

This layer should support:
1. AI-assisted correction proposal generation.
2. Human approval before policy activation.
3. Structured, scoped, versioned policies.
4. Deterministic runtime application during query understanding, retrieval planning, query expansion, source boosting/demotion, reranking, and answer grounding.
5. Audit trails and explainability.
6. Rollback/deactivation.
7. Conflict detection.
8. Evaluation/impact simulation before activation.

Do not implement a fully AI-only dynamic correction system where the LLM decides the meaning of approved business terms at runtime without reference to approved policy. AI can assist, but approved policies are the source of truth.

Recommended terminology:
- Use “Knowledge Policy Layer” or “Correction Policy Layer” instead of “rule layer.”
- Use “policy” instead of “rule” where possible.
- Use “correction proposal” for AI-suggested changes awaiting review.
- Use “approved policy” for activated corrections.
- Use “policy application trace” for runtime explainability.

Primary entities to design or update:

1. CorrectionFeedback
Represents raw user feedback on a bad answer, bad retrieval result, wrong term interpretation, missing document, outdated document, etc.

Suggested fields:
- id
- tenantId
- propertyId nullable
- department nullable
- userId
- conversationId nullable
- queryText
- answerText nullable
- retrievedDocumentIds nullable
- feedbackType enum:
  - wrong_term_interpretation
  - missing_document
  - wrong_document_rank
  - outdated_document
  - source_should_be_boosted
  - source_should_be_demoted
  - incorrect_answer
  - other
- feedbackText
- language nullable
- createdAt

2. CorrectionProposal
Represents an AI-generated or manually created proposed correction.

Suggested fields:
- id
- tenantId
- sourceFeedbackIds array
- proposalType enum:
  - terminology_mapping
  - query_expansion
  - source_boost
  - source_demotion
  - document_version_preference
  - document_exclusion
  - intent_mapping
  - answer_instruction
- status enum:
  - draft
  - pending_review
  - approved
  - rejected
  - superseded
- proposedBy enum:
  - ai
  - human
  - system
- term nullable
- canonicalMeaning nullable
- description
- rationale
- confidenceScore nullable
- suggestedScope object
- suggestedPolicy object
- conflictPolicyIds array nullable
- impactSimulationId nullable
- createdAt
- updatedAt
- reviewedBy nullable
- reviewedAt nullable
- reviewNotes nullable

3. KnowledgePolicy
Represents an approved, governed correction policy used at runtime.

Suggested fields:
- id
- tenantId
- policyType enum:
  - terminology_mapping
  - query_expansion
  - source_boost
  - source_demotion
  - document_version_preference
  - document_exclusion
  - intent_mapping
  - answer_instruction
- status enum:
  - active
  - inactive
  - superseded
  - archived
- version
- name
- description
- scope object:
  - propertyIds nullable array
  - departmentIds nullable array
  - userRoleIds nullable array
  - languages nullable array
  - documentTypeIds nullable array
  - effectiveFrom nullable
  - effectiveUntil nullable
- matchConditions object:
  - terms nullable array
  - aliases nullable array
  - intents nullable array
  - queryPatterns nullable array
  - documentIds nullable array
  - metadataFilters nullable object
- actions object:
  - canonicalTerm nullable
  - canonicalMeaning nullable
  - expandQueryWith nullable array
  - boostDocumentIds nullable array
  - demoteDocumentIds nullable array
  - excludeDocumentIds nullable array
  - preferDocumentIds nullable array
  - preferLatestVersion boolean nullable
  - rerankBoost nullable number
  - rerankPenalty nullable number
  - answerInstruction nullable string
- priority integer
- conflictGroup nullable
- createdFromProposalId nullable
- approvedBy
- approvedAt
- createdAt
- updatedAt
- deactivatedBy nullable
- deactivatedAt nullable
- deactivationReason nullable

4. PolicyApplicationTrace
Records how policies affected a runtime query.

Suggested fields:
- id
- tenantId
- conversationId nullable
- queryId
- queryText
- appliedPolicyIds array
- skippedPolicyIds nullable array
- detectedTerms nullable array
- expandedQuery nullable
- retrievalAdjustments object:
  - boostedDocumentIds nullable array
  - demotedDocumentIds nullable array
  - excludedDocumentIds nullable array
  - preferredDocumentIds nullable array
- rankingAdjustments nullable object
- explanation
- createdAt

5. PolicyConflict
Represents detected conflicts between proposals or approved policies.

Suggested fields:
- id
- tenantId
- conflictType enum:
  - overlapping_scope
  - contradictory_term_mapping
  - boost_and_demote_same_source
  - version_preference_conflict
  - exclusion_conflict
  - duplicate_policy
- policyIds array nullable
- proposalIds array nullable
- description
- severity enum:
  - low
  - medium
  - high
  - blocking
- status enum:
  - open
  - resolved
  - ignored
- resolutionNotes nullable
- resolvedBy nullable
- resolvedAt nullable
- createdAt

6. PolicyImpactSimulation
Represents evaluation before approving a policy.

Suggested fields:
- id
- tenantId
- proposalId nullable
- policyDraft object
- testQueryIds array nullable
- sampleQueries array nullable
- affectedQueryCount
- improvedCount nullable
- degradedCount nullable
- neutralCount nullable
- uncertainCount nullable
- beforeAfterExamples array
- summary
- createdAt

Runtime behavior to implement or document:

When a user query is received:
1. Query Understanding:
   - Detect language, property, department, user role, intent, and important terms.
   - AI may assist in detection, but approved KnowledgePolicy records must be checked deterministically.

2. Policy Matching:
   - Match active policies by tenant, scope, language, term/alias, intent, document metadata, and effective date.
   - Resolve conflicts by priority, specificity, version, and conflictGroup.

3. Retrieval Planning:
   - Apply terminology mappings and query expansion.
   - Add approved aliases and canonical meanings.
   - Apply source boosts, demotions, exclusions, and version preferences.
   - Preserve the original query as well as expanded forms.

4. Retrieval and Reranking:
   - Retrieve using hybrid search if available.
   - Include policy-derived features in ranking.
   - Apply rerankBoost/rerankPenalty deterministically.
   - Prefer latest or approved document versions where policies require it.

5. Answer Generation:
   - Ground the answer in retrieved sources.
   - Apply answerInstruction policies only if scoped and active.
   - Do not allow the LLM to override approved policies silently.
   - If the answer depends on a policy, include trace metadata internally.

6. Trace:
   - Create a PolicyApplicationTrace for debugging, audit, and reviewer UI.

AI-assisted workflow to implement or document:

1. User submits feedback.
2. Store CorrectionFeedback.
3. AI analyzes feedback and creates one or more CorrectionProposal records.
4. AI should suggest:
   - proposalType
   - term or issue
   - canonical meaning
   - aliases/query expansions
   - affected documents
   - suggested scope
   - rationale
   - confidenceScore
   - possible conflicts
5. System runs conflict detection.
6. System optionally runs impact simulation against historical queries.
7. Human reviewer approves, edits, rejects, or requests more data.
8. Approved proposal becomes active KnowledgePolicy.
9. Runtime system applies active policies deterministically.
10. All applications are traced.

Important design principles:
- Human-approved policy is the source of truth.
- AI-generated proposals are not automatically active unless explicitly configured.
- Policies must be scoped. Avoid global policies by default.
- Prefer narrow scope first: tenant + property + department + language.
- Every active policy should be explainable, auditable, versioned, and reversible.
- Do not hard-code business terms in application logic.
- Store business knowledge in policy records.
- Runtime behavior should be deterministic given the same query, metadata, policy set, and document index.
- The system should support multilingual terms, especially Traditional Chinese and English mixed queries.
- The system should support property-specific terminology differences.
- The system should distinguish between:
  - feedback,
  - proposal,
  - approved policy,
  - runtime trace,
  - conflict,
  - impact simulation.

Example scenario to include in docs/tests:

User feedback:
“No, 關水喉 here means shutting the water supply valve, not closing the faucet.”

Expected AI-created CorrectionProposal:
- proposalType: terminology_mapping
- term: 關水喉
- canonicalMeaning: shut or isolate the water supply valve
- suggested aliases:
  - 關水掣
  - 關閉供水閥
  - shut water supply valve
  - isolate water supply
  - close stopcock
  - shut riser valve
- suggested scope:
  - propertyId: current property if available
  - department: maintenance if available
  - language: zh-Hant, en
- rationale:
  - Feedback indicates wrong interpretation of a Cantonese/Traditional Chinese maintenance term.
- status: pending_review

Expected approved KnowledgePolicy:
- policyType: terminology_mapping
- active
- scoped to the relevant tenant/property/department/language
- matchConditions.terms includes 關水喉
- matchConditions.aliases includes 關水掣 etc.
- actions.canonicalMeaning = shut or isolate the water supply valve
- actions.expandQueryWith includes English and Chinese aliases
- actions.boostDocumentTypes or metadata filters may prefer plumbing SOPs, if supported
- priority set based on specificity

Expected runtime:
Query:
“tenant says need 關水喉 for renovation”

System should:
- detect term 關水喉
- match the approved policy
- expand query with “isolate water supply”, “shut water supply valve”, etc.
- boost relevant plumbing/maintenance SOPs
- produce answer grounded in retrieved SOPs
- create PolicyApplicationTrace showing which policy was applied and how retrieval changed.

Please update:
1. Database schema or ORM models.
2. API contracts/types.
3. Migration files if applicable.
4. Retrieval pipeline design.
5. Reviewer/admin UI data model if applicable.
6. Unit tests for policy matching, scoping, conflict detection, and trace creation.
7. Integration tests for the 關水喉 example.
8. Documentation explaining why this is a Knowledge Policy Layer, not a static rule engine.

Please also propose any naming improvements if the existing codebase has names like Rule, RuleEngine, RuleEvaluation, etc. Suggested replacements:
- Rule -> KnowledgePolicy
- RuleEngine -> PolicyResolver or KnowledgePolicyResolver
- RuleEvaluation -> PolicyApplicationTrace
- RuleSuggestion -> CorrectionProposal
- UserCorrection -> CorrectionFeedback
- RuleConflict -> PolicyConflict
- RuleSimulation -> PolicyImpactSimulation

Acceptance criteria:
- The design no longer presents the system as a simple static rule engine.
- AI is used to propose and enrich corrections, not to silently override approved policies.
- Approved policies are deterministic, scoped, auditable, versioned, and reversible.
- Runtime policy application is traceable.
- The 關水喉 terminology example works end to end.
- The code and docs clearly distinguish AI-assisted proposal generation from deterministic approved policy application.