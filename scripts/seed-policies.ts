import "./_loadEnv";
import {
  addFeedback,
  approveProposalToPolicy,
  listActivePolicies,
} from "../src/lib/policies";
import { generateProposalsFromFeedback } from "../src/lib/proposal-engine";
import { getProposal } from "../src/lib/policies";
import { detectAndRecordForProposal } from "../src/lib/conflict-detection";
import { env } from "../src/lib/env";

// ---------------------------------------------------------------------------
// Seed the Knowledge Policy Layer with the canonical 關水喉 demo scenario,
// exercising the full governed workflow deterministically (no LLM required):
//
//   feedback -> AI/heuristic proposal -> conflict detection -> human approval
//            -> active KnowledgePolicy
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `Seeding Knowledge Policy Layer in ${env.dbName} (tenant "${env.defaultTenantId}")...`
  );

  // 1. Raw human feedback: "關水喉 means shutting the water supply valve".
  const fb = await addFeedback({
    tenantId: env.defaultTenantId,
    propertyId: "grand-yoho",
    department: "maintenance",
    userId: "reviewer-demo",
    conversationId: null,
    queryText: "tenant says need 關水喉 for renovation",
    answerText: "Close the faucet before starting work.",
    retrievedDocumentIds: null,
    feedbackType: "wrong_term_interpretation",
    feedbackText:
      "No, 關水喉 here means shutting the water supply valve, not closing the faucet.",
    language: "zh-Hant",
  });
  console.log(`  feedback: ${fb.id}`);

  // 2. AI-assisted proposal (forced heuristic for a reproducible seed).
  const [proposal] = await generateProposalsFromFeedback(fb, {
    useLlm: false,
  });
  console.log(
    `  proposal: ${proposal.id} [${proposal.proposalType}] confidence=${proposal.confidenceScore}`
  );
  console.log(
    `    canonicalMeaning: ${proposal.canonicalMeaning}\n` +
      `    aliases: ${(
        proposal.suggestedPolicy.actions.expandQueryWith ?? []
      ).join(", ")}`
  );

  // 3. Governance-time conflict detection (advisory).
  const conflicts = await detectAndRecordForProposal(proposal);
  console.log(`  conflicts detected: ${conflicts.length}`);

  // 4. Human approval -> active policy (the ONLY path to runtime authority).
  const fresh = (await getProposal(proposal.id))!;
  const policy = await approveProposalToPolicy(fresh, "reviewer-demo");
  console.log(
    `  APPROVED policy: ${policy.id} v${policy.version} [${policy.policyType}] conflictGroup=${policy.conflictGroup}`
  );

  const active = await listActivePolicies();
  console.log(
    `\nActive policies now: ${active.length}. Try the query "tenant says need 關水喉 for renovation" in Compare / RAG.`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
