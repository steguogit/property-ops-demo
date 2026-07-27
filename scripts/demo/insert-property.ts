import "../_loadEnv";
import { getCollection } from "../../src/lib/mongo";
import { env, isAtlasEmbedding, hasVoyage } from "../../src/lib/env";
import { voyageEmbed } from "../../src/lib/voyage";

/**
 * LIVE DEMO INSERTER - NEW PROPERTY
 * ---------------------------------
 * Inserts a brand-new property document during the demo to show that Atlas
 * Vector Search makes the data searchable *immediately* after the write
 * (with EMBEDDING_STRATEGY=atlas, Atlas auto-embeds `chunkText` on insert).
 *
 * Usage (all optional - sensible demo defaults provided):
 *   tsx scripts/demo/insert-property.ts \
 *     --name "The Quayside" \
 *     --aliases "TQ,啟匯,Kwun Tong Quayside" \
 *     --segment office_tower \
 *     --region "Kowloon East" \
 *     --manager "Peter Chan" \
 *     --text "free-form description used as the searchable chunkText"
 */

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const propertyName = arg("--name", "The Quayside");
  const aliases = arg("--aliases", "TQ,啟匯,Kwun Tong Quayside")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const segment = arg("--segment", "office_tower");
  const region = arg("--region", "Kowloon East");
  const manager = arg("--manager", "Peter Chan");

  // A short numeric id keeps the demo register tidy and lets you run repeatedly.
  const stamp = Date.now().toString().slice(-6);
  const docId = arg("--docId", `PROP-LIVE-${stamp}`);

  const defaultText =
    `PROPERTY PROFILE - ${propertyName} (${aliases.join(" / ")}). ` +
    `Segment: ${segment}. Region: ${region}. ` +
    `${propertyName} is a newly onboarded ${segment.replace("_", " ")} in ${region}. ` +
    `Duty Manager: ${manager}, on-call 24/7 for after-hours operations and incident escalation. ` +
    `Building services include chilled-water HVAC, loading-bay access control, and overnight contractor fitting-out support. ` +
    `Resolve all incidents, work permits, and roster entries for ${propertyName} against this profile before routing.`;

  const chunkText = arg("--text", defaultText);

  const record: any = {
    _id: `${docId}#0`,
    docId,
    docType: "property_profile",
    title: `Property Profile - ${propertyName}`,
    propertyName,
    propertyAliases: aliases,
    segment,
    region,
    language: ["en", "zh"],
    audience: ["internal_staff"],
    tags: ["property", "onboarding", "operations", "live_demo"],
    exactTerms: [propertyName, ...aliases, manager],
    extractedFields: {
      dutyManager: manager,
      onboarded: new Date().toISOString().slice(0, 10),
      source: "live_demo_insert",
    },
    sourceFileName: "live_demo_property.md",
    updatedAt: new Date().toISOString().slice(0, 10),
    sourceText: chunkText,
    chunkText,
    chunkIndex: 0,
  };

  // Atlas auto-embedding embeds chunkText on write; explicit Voyage strategy
  // needs the vector written here so the doc is searchable straight away.
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

  console.log("\n  NEW PROPERTY WRITTEN TO ATLAS");
  console.log("  ------------------------------------------------------------");
  console.log(`  property : ${propertyName}`);
  console.log(`  aliases  : ${aliases.join(", ")}`);
  console.log(`  segment  : ${segment}   region: ${region}`);
  console.log(`  manager  : ${manager}`);
  console.log(`  _id      : ${record._id}`);
  console.log(`  write    : ${ms} ms  ->  ${env.dbName}.${env.collectionName}`);
  if (isAtlasEmbedding()) {
    console.log("  embed    : Atlas Auto-Embedding (chunkText) - vector ready on write");
  }
  console.log("  ------------------------------------------------------------");
  console.log(`  TRY NOW in the UI:  "Tell me about ${propertyName}"`);
  console.log(`                      "Who is the duty manager at ${propertyName}?"\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
