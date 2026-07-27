import "./_loadEnv";
import { listCorrections, correctionToPolicy } from "../src/lib/corrections";
import { createPolicy } from "../src/lib/policies";
import { env } from "../src/lib/env";

// ---------------------------------------------------------------------------
// One-time migration: legacy `user_corrections` -> governed `knowledge_policies`.
//
// Only ACTIVE corrections are migrated (active=false were reversed by a
// reviewer). Each becomes an approved KnowledgePolicy with a global-ish scope
// that a reviewer should subsequently narrow. Idempotency: policies carry
// `createdFromProposalId=null` and a name prefixed "Migrated:"; re-running will
// create duplicates, so run once (or clear knowledge_policies first).
// ---------------------------------------------------------------------------

async function main() {
  const all = await listCorrections();
  const active = all.filter((c) => c.active !== false);
  console.log(
    `Found ${all.length} legacy corrections (${active.length} active) in ${env.dbName}.${env.correctionsCollection}.`
  );

  let migrated = 0;
  for (const c of active) {
    const shape = correctionToPolicy(c);
    const policy = await createPolicy(shape);
    migrated++;
    console.log(
      `  → ${c.correctionId} (${c.type}) -> policy ${policy.id} [${policy.policyType}]`
    );
  }

  console.log(
    `\nMigrated ${migrated} correction(s) into ${env.dbName}.${env.policiesCollection}.` +
      `\nReview and NARROW the scope of each migrated policy — legacy corrections had no property/department context.`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
