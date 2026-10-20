// =============================================================================
// Building Operations Control Room — one-time setup.
//
//   * Creates the native time-series telemetry collection (explicit options,
//     with a safe conflict check — never silently drops an existing one).
//   * Creates supporting indexes based on actual access patterns.
//   * Creates the knowledge Atlas Search (lexical) + Vector Search (autoEmbed)
//     indexes.
//   * Seeds the asset catalog and the knowledge corpus (idempotent upserts).
//
// Safe to re-run. Does NOT touch any existing (non-bops_) collections.
// Usage: npm run bops:setup
// =============================================================================
import "./_loadEnv";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getDb } from "../src/lib/mongo";
import { env } from "../src/lib/env";
import {
  BOPS,
  BOPS_INDEXES,
  TELEMETRY,
  ASSET_SEEDS,
  SITE,
  ZONES,
} from "../src/lib/bops/config";
import { assetsCol, knowledgeCol } from "../src/lib/bops/mongo";
import type { AssetDoc, KnowledgeDoc } from "../src/lib/bops/mongo";

async function ensureTimeSeries() {
  const db = await getDb();
  const existing = await db.listCollections({ name: BOPS.telemetry }).toArray();
  const desired = {
    timeField: "ts",
    metaField: "meta",
    granularity: TELEMETRY.granularity,
  };
  if (existing.length) {
    const opts = ((existing[0] as any).options as any) ?? {};
    const ts = opts.timeseries;
    if (!ts) {
      console.error(
        `CONFLICT: "${BOPS.telemetry}" exists but is NOT a time-series collection. ` +
          `Refusing to drop shared data. Rename or remove it manually, then re-run.`
      );
      process.exitCode = 1;
      return;
    }
    if (ts.timeField !== desired.timeField || ts.metaField !== desired.metaField) {
      console.error(
        `CONFLICT: "${BOPS.telemetry}" time-series options differ ` +
          `(found timeField=${ts.timeField}, metaField=${ts.metaField}). Not modifying.`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`time-series "${BOPS.telemetry}" already exists — keeping.`);
  } else {
    await db.createCollection(BOPS.telemetry, {
      timeseries: desired,
      // Bucket-based, asynchronous expiry. Reset appears instant because the UI
      // switches runs — not because TTL deletion is immediate.
      expireAfterSeconds: TELEMETRY.expireAfterSeconds,
    } as any);
    console.log(
      `Created time-series "${BOPS.telemetry}" (timeField=ts, metaField=meta, ` +
        `granularity=${TELEMETRY.granularity}, expireAfterSeconds=${TELEMETRY.expireAfterSeconds}).`
    );
  }
}

async function ensureSupportingIndexes() {
  const db = await getDb();
  // events: correlation queries by run + building + zone + eventTime; TTL cleanup.
  const events = db.collection(BOPS.events);
  await events.createIndex(
    { runId: 1, buildingId: 1, zoneId: 1, eventTime: 1 },
    { name: "corr_lookup" }
  );
  await events.createIndex({ eventId: 1 }, { unique: true, name: "eventId_unique" });
  await events.createIndex(
    { createdAt: 1 },
    { name: "ttl_createdAt", expireAfterSeconds: TELEMETRY.expireAfterSeconds }
  );
  // incidents: dedup lookup by run+asset+rule+status; TTL cleanup.
  const incidents = db.collection(BOPS.incidents);
  await incidents.createIndex(
    { runId: 1, assetId: 1, ruleId: 1, status: 1 },
    { name: "dedup_lookup" }
  );
  await incidents.createIndex(
    { detectedAt: 1 },
    { name: "ttl_detectedAt", expireAfterSeconds: TELEMETRY.expireAfterSeconds }
  );
  // runs: TTL cleanup of stale run config.
  const runs = db.collection(BOPS.runs);
  await runs.createIndex(
    { createdAt: 1 },
    { name: "ttl_createdAt", expireAfterSeconds: TELEMETRY.expireAfterSeconds }
  );
  console.log("Supporting indexes ensured (events, incidents, runs).");
}

async function ensureSearchIndexes() {
  const col: any = await knowledgeCol();
  let existing: string[] = [];
  try {
    existing = (await col.listSearchIndexes().toArray()).map((i: any) => i.name);
  } catch {
    /* collection may not exist yet; createSearchIndex creates it */
  }

  const recreate = process.argv.includes("--recreate");

  // Lexical (Atlas Search) index. Each filter/facet field is mapped with BOTH
  // `token` (for the compound.filter `equals` operator) and `stringFacet` (for
  // the $searchMeta facet collector → facet-based navigation).
  const lexicalDef = {
    name: BOPS_INDEXES.knowledgeLexical,
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          title: { type: "string" },
          chunkText: { type: "string" },
          equipmentType: [{ type: "token" }, { type: "stringFacet" }],
          docType: [{ type: "token" }, { type: "stringFacet" }],
        },
      },
    },
  };
  if (existing.includes(BOPS_INDEXES.knowledgeLexical) && recreate) {
    try {
      await col.dropSearchIndex(BOPS_INDEXES.knowledgeLexical);
      console.log(`Dropped "${BOPS_INDEXES.knowledgeLexical}" (--recreate).`);
      await new Promise((r) => setTimeout(r, 3000));
      existing = existing.filter((n) => n !== BOPS_INDEXES.knowledgeLexical);
    } catch (e) {
      console.warn(`Could not drop lexical index:`, (e as Error).message);
    }
  }
  if (!existing.includes(BOPS_INDEXES.knowledgeLexical)) {
    try {
      await col.createSearchIndex(lexicalDef);
      console.log(`Created Atlas Search index "${BOPS_INDEXES.knowledgeLexical}" (with facets).`);
    } catch (e) {
      console.error(
        `Failed to create "${BOPS_INDEXES.knowledgeLexical}":`,
        (e as Error).message
      );
    }
  } else {
    console.log(
      `Atlas Search index "${BOPS_INDEXES.knowledgeLexical}" exists — skipping. ` +
        `Use \`npm run bops:setup -- --recreate\` to rebuild with facet fields.`
    );
  }

  // Vector Search index — Atlas automatic embedding over chunkText (voyage-4).
  if (!existing.includes(BOPS_INDEXES.knowledgeVector)) {
    try {
      await col.createSearchIndex({
        name: BOPS_INDEXES.knowledgeVector,
        type: "vectorSearch",
        definition: {
          fields: [
            {
              type: "autoEmbed",
              path: "chunkText",
              modality: "text",
              model: env.atlasAutoEmbedModel, // voyage-4 family
            },
            { type: "filter", path: "equipmentType" },
            { type: "filter", path: "docType" },
          ],
        },
      });
      console.log(
        `Created Vector Search (autoEmbed, ${env.atlasAutoEmbedModel}) index "${BOPS_INDEXES.knowledgeVector}".`
      );
    } catch (e) {
      console.error(
        `Failed to create "${BOPS_INDEXES.knowledgeVector}":`,
        (e as Error).message,
        "\nNote: autoEmbed requires an Atlas cluster/region that supports Automatic Embedding."
      );
    }
  } else {
    console.log(`Vector Search index "${BOPS_INDEXES.knowledgeVector}" exists — skipping.`);
  }
}

function zoneName(zoneId: string): { name: string; level: string } {
  const z = Object.values(ZONES).find((z) => z.zoneId === zoneId);
  return { name: z?.name ?? zoneId, level: z?.level ?? "" };
}

async function seedAssets() {
  const col = await assetsCol();
  const now = new Date().toISOString();
  for (const a of ASSET_SEEDS) {
    const z = zoneName(a.zoneId);
    const doc: AssetDoc = {
      assetId: a.assetId,
      type: a.type,
      system: a.system,
      name: a.name,
      vendor: a.vendor,
      model: a.model,
      siteId: SITE.siteId,
      siteName: SITE.siteName,
      buildingId: SITE.buildingId,
      buildingName: SITE.buildingName,
      zoneId: a.zoneId,
      zoneName: z.name,
      level: z.level,
      specs: a.specs,
      points: a.points,
      maintenance: a.maintenance,
      updatedAt: now,
    };
    await col.updateOne(
      { _id: a.assetId as any },
      { $set: { ...doc, _id: a.assetId } as any },
      { upsert: true }
    );
  }
  console.log(`Seeded ${ASSET_SEEDS.length} assets (idempotent upsert).`);
}

async function seedKnowledge() {
  const col = await knowledgeCol();
  const file = resolve(process.cwd(), "seed", "bops_knowledge.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<KnowledgeDoc>[];
  const now = new Date().toISOString();
  for (const k of raw) {
    const doc: KnowledgeDoc = {
      docId: k.docId!,
      docType: k.docType!,
      title: k.title!,
      chunkText: k.chunkText!,
      equipmentType: (k.equipmentType as any) ?? "general",
      model: k.model,
      source: k.source!,
      revision: k.revision!,
      docDate: k.docDate!,
      assetRef: k.assetRef,
      timeRangeRef: k.timeRangeRef,
      procedure: k.procedure,
      history: k.history,
      embeddingProvenance: {
        strategy: "atlas_auto_embed",
        model: env.atlasAutoEmbedModel,
        field: "chunkText",
      },
      updatedAt: now,
    };
    await col.updateOne(
      { _id: doc.docId as any },
      { $set: { ...doc, _id: doc.docId } as any },
      { upsert: true }
    );
  }
  console.log(`Seeded ${raw.length} knowledge documents (idempotent upsert).`);
}

async function main() {
  console.log(`BOPS setup → db "${env.dbName}"`);
  await ensureTimeSeries();
  await ensureSupportingIndexes();
  await seedAssets();
  await seedKnowledge();
  await ensureSearchIndexes();
  console.log("\nBOPS setup complete. Search indexes may take ~1–2 min to build.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
