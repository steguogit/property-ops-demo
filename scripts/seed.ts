import "./_loadEnv";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  getCollection,
  getAliasesCollection,
  getVersionsCollection,
} from "../src/lib/mongo";
import { env, hasVoyage, hasMultimodalEmbed } from "../src/lib/env";
import { voyageEmbed, voyageEmbedMultimodal } from "../src/lib/voyage";
import { chunkText } from "./chunk";

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
  // iteration-2 lifecycle fields (optional)
  versionLabel?: string;
  versionGroupId?: string;
  obsoleteFlag?: boolean;
  supersededBy?: string;
  effectiveFrom?: string;
  relatedDocumentIds?: string[];
}

function loadJson<T>(file: string): T[] {
  const p = resolve(process.cwd(), "seed", file);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8")) as T[];
}

async function main() {
  const docs = [
    ...loadJson<SeedDoc>("property_docs.json"),
    ...loadJson<SeedDoc>("property_docs_icc.json"),
    ...loadJson<SeedDoc>("property_docs_v2.json"),
    ...loadJson<SeedDoc>("property_docs_mn.json"),
  ];
  console.log(`Loaded ${docs.length} source documents (base + icc + v2 + mn).`);

  const col = await getCollection();

  // Build chunk records. We honour the curated chunkText if present, and also
  // split very long sourceText. exactTerms/aliases are duplicated onto each
  // chunk so lexical boosting works per-chunk.
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
      sopTopic: d.sopTopic,
      incidentType: d.incidentType,
      exactTerms: d.exactTerms,
      extractedFields: d.extractedFields,
      sourceText: d.sourceText,
      sourceFileName: d.sourceFileName,
      updatedAt: d.updatedAt,
      // iteration-2 lifecycle / source-traceability fields
      documentId: d.docId,
      versionLabel: d.versionLabel,
      versionGroupId: d.versionGroupId,
      obsoleteFlag: d.obsoleteFlag ?? false,
      supersededBy: d.supersededBy,
      effectiveFrom: d.effectiveFrom,
      relatedDocumentIds: d.relatedDocumentIds ?? [],
    };

    // Primary curated chunk (chunkIndex 0) - tuned for the demo queries.
    records.push({ _id: `${d.docId}#0`, ...base, chunkText: d.chunkText, chunkIndex: 0 });

    // Additional chunks from the full sourceText, if it's long.
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

  console.log(`Prepared ${records.length} chunks.`);

  // Embedding strategy.
  if (env.embeddingStrategy === "atlas") {
    console.log(
      "EMBEDDING_STRATEGY=atlas -> NOT generating embeddings locally. " +
        "Atlas Auto Embedding will embed the 'chunkText' field. " +
        "Ensure your vector index uses autoEmbedding (see atlas-indexes/)."
    );
  } else if (hasVoyage()) {
    console.log(`Generating Voyage embeddings (${env.voyageEmbedModel})...`);
    const batchSize = 32;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const vectors = await voyageEmbed(
        batch.map((r) => r.chunkText),
        "document"
      );
      batch.forEach((r, j) => (r.embedding = vectors[j]));
      console.log(`  embedded ${Math.min(i + batchSize, records.length)}/${records.length}`);
    }
  } else {
    console.warn(
      "WARNING: VOYAGE_API_KEY not set and EMBEDDING_STRATEGY!=atlas. " +
        "Seeding WITHOUT embeddings - vector search will not work."
    );
  }

  // Secondary multimodal embedding (voyage-multimodal-3.5), stored explicitly in
  // `embeddingMultimodal` for the model-comparison feature. Independent of the
  // primary strategy above.
  if (hasMultimodalEmbed() && records.length) {
    console.log(
      `Generating multimodal embeddings (${env.multimodalEmbedModel})...`
    );
    const batchSize = 32;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const vectors = await voyageEmbedMultimodal(
        batch.map((r) => r.chunkText),
        "document"
      );
      batch.forEach((r, j) => ((r as any).embeddingMultimodal = vectors[j]));
      console.log(
        `  mm-embedded ${Math.min(i + batchSize, records.length)}/${records.length}`
      );
    }
  }

  // Upsert (idempotent re-seed).
  console.log("Writing chunks to Atlas...");
  await col.deleteMany({});
  if (records.length) await col.insertMany(records as any);
  console.log(
    `Inserted ${records.length} chunks into ${env.dbName}.${env.collectionName}.`
  );

  // ----- property_aliases master data -----
  const aliases = loadJson<any>("property_aliases.json").map((a) => ({
    ...a,
    updatedAt: a.updatedAt ?? new Date().toISOString(),
  }));
  if (aliases.length) {
    const aliasCol = await getAliasesCollection();
    await aliasCol.deleteMany({});
    await aliasCol.insertMany(aliases as any);
    console.log(`Inserted ${aliases.length} property_aliases records.`);
  }

  // ----- document_versions groups (derived from versionGroupId) -----
  const groups = new Map<string, SeedDoc[]>();
  for (const d of docs) {
    if (!d.versionGroupId) continue;
    if (!groups.has(d.versionGroupId)) groups.set(d.versionGroupId, []);
    groups.get(d.versionGroupId)!.push(d);
  }
  if (groups.size) {
    const versionsCol = await getVersionsCollection();
    await versionsCol.deleteMany({});
    const groupDocs = [...groups.entries()].map(([versionGroupId, members]) => {
      const sorted = [...members].sort((a, b) =>
        (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? "")
      );
      const current = sorted.find((m) => !m.obsoleteFlag) ?? sorted[0];
      return {
        _id: versionGroupId,
        versionGroupId,
        title: current.title.replace(/\s*\(.*\)\s*$/, ""),
        propertyName: current.propertyName,
        currentDocumentId: current.docId,
        versions: sorted.map((m) => ({
          documentId: m.docId,
          versionLabel: m.versionLabel ?? "v?",
          effectiveFrom: m.effectiveFrom,
          obsolete: m.obsoleteFlag ?? m.docId !== current.docId,
        })),
        updatedAt: new Date().toISOString(),
      };
    });
    await versionsCol.insertMany(groupDocs as any);
    console.log(`Inserted ${groupDocs.length} document_versions groups.`);
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
