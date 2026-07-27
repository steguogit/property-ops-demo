import "../_loadEnv";
import { getCollection } from "../../src/lib/mongo";
import { env, isAtlasEmbedding, hasVoyage } from "../../src/lib/env";
import { voyageEmbed } from "../../src/lib/voyage";

/**
 * LIVE DEMO INSERTER - PETER CHAN ROSTER UPDATE
 * ---------------------------------------------
 * Adds (or updates) a duty-roster record for Peter Chan during the demo to
 * show that the new assignment is *immediately* retrievable via Atlas Vector
 * Search. With EMBEDDING_STRATEGY=atlas, Atlas re-embeds `chunkText` on every
 * insert/update - so editing Peter's record auto-refreshes its vector.
 *
 * Usage (all optional):
 *   tsx scripts/demo/insert-peter.ts \
 *     --property "The Quayside" \
 *     --role "Duty Manager" \
 *     --shift "overnight 23:00-07:00" \
 *     --aliases "Chan Tai Man,P. T. Chan,陳大文" \
 *     --text "free-form roster note used as the searchable chunkText"
 */

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const person = arg("--person", "Peter Chan");
  const property = arg("--property", "The Quayside");
  const role = arg("--role", "Duty Manager");
  const shift = arg("--shift", "overnight 23:00-07:00");
  const aliases = arg("--aliases", "Chan Tai Man,P. T. Chan,陳大文")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const stamp = Date.now().toString().slice(-6);
  const docId = arg("--docId", `ROSTER-LIVE-${stamp}`);

  const defaultText =
    `DUTY ROSTER UPDATE (Hong Kong). NEW ASSIGNMENT: ${person} ` +
    `(also recorded as ${aliases.join(", ")} - SAME person) is now the ` +
    `${role} for ${property}, covering the ${shift} shift, on-call 24/7. ` +
    `${person} handles after-hours operations, incident escalation, and ` +
    `overnight contractor liaison for ${property}. ` +
    `Effective ${new Date().toISOString().slice(0, 10)}. ` +
    `For ${property} after-hours, contact ${person} first (response within 30 minutes), ` +
    `then Group Operations Control Room.`;

  const chunkText = arg("--text", defaultText);

  const record: any = {
    _id: `${docId}#0`,
    docId,
    docType: "duty_roster",
    title: `Duty Roster Update - ${person} @ ${property}`,
    propertyName: property,
    propertyAliases: ["duty roster", "on-call", "contacts"],
    segment: "master_data",
    region: "Hong Kong",
    language: ["en", "zh"],
    audience: ["internal_staff"],
    tags: ["roster", "contacts", "duty_manager", "escalation", "live_demo"],
    exactTerms: [person, ...aliases, property, role, "duty manager", "after-hours"],
    extractedFields: {
      person,
      assignedProperty: property,
      role,
      shift,
      effective: new Date().toISOString().slice(0, 10),
      source: "live_demo_insert",
    },
    sourceFileName: "live_demo_roster.md",
    updatedAt: new Date().toISOString().slice(0, 10),
    sourceText: chunkText,
    chunkText,
    chunkIndex: 0,
  };

  if (!isAtlasEmbedding()) {
    if (hasVoyage()) {
      const [vec] = await voyageEmbed([chunkText], "document");
      record.embedding = vec;
    } else {
      console.warn(
        "WARNING: EMBEDDING_STRATEGY!=atlas and no VOYAGE_API_KEY - inserting WITHOUT a vector; vector search will not find this doc."
      );
    }
  }

  const col = await getCollection();
  const t0 = Date.now();
  await col.replaceOne({ _id: record._id }, record, { upsert: true });
  const ms = Date.now() - t0;

  console.log("\n  PETER CHAN ROSTER UPDATE WRITTEN TO ATLAS");
  console.log("  ------------------------------------------------------------");
  console.log(`  person   : ${person}  (= ${aliases.join(" = ")})`);
  console.log(`  property : ${property}`);
  console.log(`  role     : ${role}   shift: ${shift}`);
  console.log(`  _id      : ${record._id}`);
  console.log(`  write    : ${ms} ms  ->  ${env.dbName}.${env.collectionName}`);
  if (isAtlasEmbedding()) {
    console.log("  embed    : Atlas Auto-Embedding (chunkText) - vector ready on write");
  }
  console.log("  ------------------------------------------------------------");
  console.log(`  TRY NOW in the UI:  "Who is the duty manager at ${property}?"`);
  console.log(`                      "What is Peter Chan's latest assignment?"\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
