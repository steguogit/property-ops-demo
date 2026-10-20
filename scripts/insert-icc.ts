import "./_loadEnv";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getCollection } from "../src/lib/mongo";
import { env, hasVoyage, hasMultimodalEmbed } from "../src/lib/env";
import { voyageEmbed, voyageEmbedMultimodal } from "../src/lib/voyage";
import { chunkText } from "./chunk";

// Non-destructive insert of the ICC sub-corpus into the existing `property`
// dataset. Mirrors scripts/seed.ts chunk-building so new docs have exactly the
// same shape as existing chunks, but UPSERTS by _id instead of wiping the
// collection. Safe to run without disturbing uploaded demo state.

interface SeedDoc {
  docId: string;
  docType: string;
  title: string;
  propertyName: string;
  propertyAliases: string[];
  segment: string;
  region?: string;
  language: string[];
  audience?: string[];
  tags: string[];
  sopTopic?: string;
  incidentType?: string;
  exactTerms: string[];
  extractedFields?: Record<string, string>;
  sourceFileName?: string;
  updatedAt?: string;
  sourceText: string;
  chunkText: string;
}

const DATASET_ID = "property";

function loadJson<T>(file: string): T[] {
  const p = resolve(process.cwd(), "seed", file);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8")) as T[];
}

async function main() {
  const docs = loadJson<SeedDoc>("property_docs_icc.json");
  console.log(`Loaded ${docs.length} ICC source documents.`);
  if (!docs.length) {
    console.error("No ICC docs found in seed/property_docs_icc.json");
    process.exit(1);
  }

  const col = await getCollection();

  const records: any[] = [];
  for (const d of docs) {
    const base = {
      docId: d.docId,
      docType: d.docType,
      title: d.title,
      propertyName: d.propertyName,
      propertyAliases: d.propertyAliases,
      segment: d.segment,
      region: d.region,
      language: d.language,
      audience: d.audience,
      tags: d.tags,
      sopTopic: d.sopTopic ?? null,
      incidentType: d.incidentType ?? null,
      exactTerms: d.exactTerms,
      extractedFields: d.extractedFields,
      sourceText: d.sourceText,
      sourceFileName: d.sourceFileName,
      updatedAt: d.updatedAt,
      documentId: d.docId,
      versionLabel: null,
      versionGroupId: null,
      obsoleteFlag: false,
      supersededBy: null,
      effectiveFrom: null,
      relatedDocumentIds: [],
      datasetId: DATASET_ID,
    };

    records.push({ _id: `${d.docId}#0`, ...base, chunkText: d.chunkText, chunkIndex: 0 });

    const extra = chunkText(d.sourceText);
    if (extra.length > 1) {
      extra.forEach((c, i) => {
        records.push({
          _id: `${d.docId}#src${i + 1}`,
          ...base,
          chunkText: c,
          chunkIndex: i + 1,
        });
      });
    }
  }
  console.log(`Prepared ${records.length} ICC chunks.`);

  // Primary embedding: with EMBEDDING_STRATEGY=atlas, Atlas auto-embeds
  // chunkText on insert — nothing to do locally. With voyage strategy, embed.
  if (env.embeddingStrategy === "atlas") {
    console.log(
      "EMBEDDING_STRATEGY=atlas -> Atlas Auto Embedding will embed 'chunkText' on insert."
    );
  } else if (hasVoyage()) {
    console.log(`Generating Voyage embeddings (${env.voyageEmbedModel})...`);
    const batchSize = 32;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const vectors = await voyageEmbed(batch.map((r) => r.chunkText), "document");
      batch.forEach((r, j) => (r.embedding = vectors[j]));
      console.log(`  embedded ${Math.min(i + batchSize, records.length)}/${records.length}`);
    }
  }

  // Secondary multimodal embedding (voyage-multimodal-3.5) for the
  // model-comparison feature — matches the existing chunks' embeddingMultimodal.
  if (hasMultimodalEmbed() && records.length) {
    console.log(`Generating multimodal embeddings (${env.multimodalEmbedModel})...`);
    const batchSize = 32;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const vectors = await voyageEmbedMultimodal(batch.map((r) => r.chunkText), "document");
      batch.forEach((r, j) => ((r as any).embeddingMultimodal = vectors[j]));
      console.log(`  mm-embedded ${Math.min(i + batchSize, records.length)}/${records.length}`);
    }
  }

  console.log("Upserting ICC chunks to Atlas (non-destructive)...");
  let upserts = 0;
  for (const r of records) {
    const { _id, ...rest } = r;
    await col.updateOne({ _id } as any, { $set: rest } as any, { upsert: true });
    upserts++;
  }
  console.log(
    `Upserted ${upserts} ICC chunks into ${env.dbName}.${env.collectionName} (datasetId=${DATASET_ID}).`
  );
  console.log("Done. Atlas auto-embedding will index chunkText within ~15s.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
