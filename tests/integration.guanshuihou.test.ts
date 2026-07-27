import "./_loadEnvOptional";
import { describe, it, itSkip, assert, assertIncludes, run } from "./_harness";
import { env } from "../src/lib/env";

// ---------------------------------------------------------------------------
// End-to-end integration test for the 關水喉 scenario against a LIVE Atlas
// cluster (per the chosen test strategy). It exercises the full governed
// workflow:
//
//   feedback -> heuristic proposal -> conflict detection -> human approval
//            -> active KnowledgePolicy -> deterministic runtime application
//            -> PolicyApplicationTrace
//
// If MONGODB_URI is not set, every case is SKIPPED (so it does not fail in CI
// without credentials). When set, it writes to the configured DB using an
// isolated tenant id so it does not disturb demo data, and cleans up after.
// ---------------------------------------------------------------------------

const HAS_DB = !!env.mongoUri;
const TEST_TENANT = `test-${Date.now()}`;

async function cleanup() {
  const {
    getFeedbackCollection,
    getProposalsCollection,
    getPoliciesCollection,
    getPolicyTracesCollection,
    getPolicyConflictsCollection,
  } = await import("../src/lib/mongo");
  const cols = [
    await getFeedbackCollection(),
    await getProposalsCollection(),
    await getPoliciesCollection(),
    await getPolicyTracesCollection(),
    await getPolicyConflictsCollection(),
  ];
  await Promise.all(cols.map((c) => c.deleteMany({ tenantId: TEST_TENANT })));
}

if (!HAS_DB) {
  describe("關水喉 end-to-end (LIVE Atlas)", () => {
    itSkip("SKIPPED: set MONGODB_URI to run the integration test", async () => {});
  });
  run();
} else {
  describe("關水喉 end-to-end (LIVE Atlas)", () => {
    it("feedback -> proposal -> approve -> deterministic policy application + trace", async () => {
      const { addFeedback, approveProposalToPolicy, getProposal } = await import(
        "../src/lib/policies"
      );
      const { generateProposalsFromFeedback } = await import(
        "../src/lib/proposal-engine"
      );
      const { detectAndRecordForProposal } = await import(
        "../src/lib/conflict-detection"
      );
      const { resolvePolicies, buildExpandedQuery } = await import(
        "../src/lib/policy-resolver"
      );
      const { listActivePolicies } = await import("../src/lib/policies");

      await cleanup();

      // 1. Feedback: 關水喉 means shutting the water supply valve.
      const fb = await addFeedback({
        tenantId: TEST_TENANT,
        propertyId: "grand-yoho",
        department: "maintenance",
        userId: "test",
        queryText: "tenant says need 關水喉 for renovation",
        answerText: "Close the faucet.",
        feedbackType: "wrong_term_interpretation",
        feedbackText:
          "No, 關水喉 here means shutting the water supply valve, not closing the faucet.",
        language: "zh-Hant",
      });

      // 2. Proposal (deterministic heuristic).
      const [proposal] = await generateProposalsFromFeedback(fb, {
        useLlm: false,
      });
      assert(
        proposal.proposalType === "terminology_mapping",
        "proposal is a terminology mapping"
      );
      assert(
        proposal.canonicalMeaning === "shut or isolate the water supply valve",
        "canonical meaning captured"
      );
      assertIncludes(
        proposal.suggestedPolicy.actions.expandQueryWith ?? [],
        "shut water supply valve",
        "English alias proposed"
      );
      assert(proposal.status === "pending_review", "proposal awaits review, NOT active");

      // 3. Conflict detection (advisory).
      await detectAndRecordForProposal(proposal);

      // 4. Approve -> active policy.
      const fresh = (await getProposal(proposal.id))!;
      const policy = await approveProposalToPolicy(fresh, "test-reviewer");
      assert(policy.status === "active", "policy active after approval");
      assert(policy.conflictGroup === "term:關水喉", "stable conflict group");

      // 5. Deterministic runtime application (query understanding -> plan).
      const active = (await listActivePolicies(TEST_TENANT)).filter(
        (p) => p.tenantId === TEST_TENANT
      );
      const plan = await resolvePolicies(
        "tenant says need 關水喉 for renovation",
        {
          tenantId: TEST_TENANT,
          propertyId: "grand-yoho",
          departmentId: "maintenance",
          language: "zh-Hant",
        },
        active
      );
      assertIncludes(
        plan.appliedPolicies.map((p) => p.id),
        policy.id,
        "approved policy applied at runtime"
      );
      assertIncludes(plan.detectedTerms, "關水喉", "term detected at runtime");
      const expanded = buildExpandedQuery(
        "tenant says need 關水喉 for renovation",
        plan
      );
      assert(
        expanded.includes("isolate water supply") ||
          expanded.includes("shut water supply valve"),
        "query expanded with approved aliases"
      );
      assert(
        plan.termMeanings.some(
          (t) => t.meaning === "shut or isolate the water supply valve"
        ),
        "authoritative canonical meaning available for grounding"
      );

      // 6. Trace persisted.
      const { recordTrace } = await import("../src/lib/policy-trace");
      const trace = await recordTrace({
        tenantId: TEST_TENANT,
        queryText: "tenant says need 關水喉 for renovation",
        expandedQuery: expanded,
        plan,
      });
      assertIncludes(trace.appliedPolicyIds, policy.id, "trace records applied policy");

      await cleanup();
    });

    it("determinism: same query + policy-set yields the same plan", async () => {
      const { resolvePolicies } = await import("../src/lib/policy-resolver");
      const now = new Date().toISOString();
      const p = {
        id: "POL-det",
        tenantId: TEST_TENANT,
        policyType: "terminology_mapping",
        status: "active",
        version: 1,
        name: "det",
        description: "",
        scope: { languages: ["zh-Hant"] },
        matchConditions: { terms: ["關水喉"] },
        actions: {
          canonicalTerm: "關水喉",
          canonicalMeaning: "shut or isolate the water supply valve",
          expandQueryWith: ["isolate water supply"],
        },
        priority: 80,
        conflictGroup: "term:關水喉",
        approvedBy: "t",
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      } as any;
      const q = "關水喉 renovation";
      const ctx = { tenantId: TEST_TENANT, language: "zh-Hant" };
      const a = await resolvePolicies(q, ctx, [p]);
      const b = await resolvePolicies(q, ctx, [p]);
      assert(
        JSON.stringify(a.appliedPolicies) === JSON.stringify(b.appliedPolicies),
        "identical resolution across runs"
      );
    });
  });

  run().finally(async () => {
    try {
      const { getClient } = await import("../src/lib/mongo");
      const client = await getClient();
      await client.close();
    } catch {
      /* ignore */
    }
  });
}
