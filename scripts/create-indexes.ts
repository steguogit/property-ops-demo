import "./_loadEnv";
import {
  getCollection,
  getConversationMessagesCollection,
  getSignaturesCollection,
  getDb,
} from "../src/lib/mongo";
import { env } from "../src/lib/env";

// Create a set of search-index definitions on a collection, idempotently.
async function createIndexesOn(
  col: any,
  defs: any[],
  recreate: boolean
): Promise<void> {
  let existing: string[] = [];
  try {
    const list = await col.listSearchIndexes().toArray();
    existing = list.map((i: any) => i.name);
  } catch {
    /* collection may not exist yet; createSearchIndex will create it */
  }
  for (const def of defs) {
    if (existing.includes(def.name)) {
      if (recreate) {
        try {
          await col.dropSearchIndex(def.name);
          console.log(`Dropped existing index "${def.name}" (--recreate).`);
          await new Promise((r) => setTimeout(r, 3000));
        } catch (e) {
          console.warn(`Could not drop "${def.name}":`, (e as Error).message);
        }
      } else {
        console.log(
          `Index "${def.name}" already exists - skipping. Use --recreate to rebuild.`
        );
        continue;
      }
    }
    try {
      await col.createSearchIndex(def as any);
      console.log(`Created index "${def.name}" (${def.type}).`);
    } catch (e) {
      console.error(`Failed to create "${def.name}":`, (e as Error).message);
      console.error(
        "If your cluster does not support programmatic index creation, " +
          "use the JSON definitions in /atlas-indexes to create them in the Atlas UI."
      );
    }
  }
}

// Creates the Atlas Vector Search index and the Atlas Search (lexical) index
// using the driver's createSearchIndexes API. Requires Atlas (Search Nodes /
// M10+ or a tier that supports Atlas Search & Vector Search).

async function main() {
  const col = await getCollection();

  const useAtlasAutoEmbed = env.embeddingStrategy === "atlas";

  // ----- Vector Search index -----
  const vectorFields: any[] = useAtlasAutoEmbed
    ? [
        {
          // Atlas Automatic Embedding: Atlas generates + stores the vector for
          // 'chunkText' on every insert/update, and embeds query strings at
          // search time. Requires a voyage-4 family model.
          type: "autoEmbed",
          path: "chunkText",
          modality: "text",
          model: env.atlasAutoEmbedModel,
        },
      ]
    : [
        {
          type: "vector",
          path: "embedding",
          numDimensions: env.voyageEmbedDim,
          similarity: "cosine",
        },
      ];

  // filterable metadata fields for $vectorSearch filtering. Includes the
  // iteration-2 lifecycle fields (obsoleteFlag/versionLabel/versionGroupId/
  // documentId) so version-aware retrieval can filter server-side.
  for (const f of [
    "docType",
    "segment",
    "propertyName",
    "language",
    "audience",
    "tags",
    "obsoleteFlag",
    "versionLabel",
    "versionGroupId",
    "documentId",
    // Multi-dataset isolation: filter every vector search to one demo dataset.
    "datasetId",
    // FSI EXPANSION: dataset isolation + exact structured filtering.
    "metadataType",
    "district",
    "floor_num",
    "unit_code",
  ]) {
    vectorFields.push({ type: "filter", path: f });
  }

  const vectorIndexDef = {
    name: env.vectorIndex,
    type: "vectorSearch",
    definition: { fields: vectorFields },
  };

  // ----- Secondary Vector Search index (voyage-multimodal-3.5 comparison) -----
  // Explicit-vector index over `embeddingMultimodal` (populated client-side).
  // Same filterable metadata fields so version-aware filtering still works.
  const mmVectorFields: any[] = [
    {
      type: "vector",
      path: "embeddingMultimodal",
      numDimensions: env.multimodalEmbedDim,
      similarity: "cosine",
    },
  ];
  for (const f of [
    "docType",
    "segment",
    "propertyName",
    "language",
    "audience",
    "tags",
    "obsoleteFlag",
    "versionLabel",
    "versionGroupId",
    "documentId",
    // Multi-dataset isolation: filter every vector search to one demo dataset.
    "datasetId",
    // FSI EXPANSION: dataset isolation + exact structured filtering.
    "metadataType",
    "district",
    "floor_num",
    "unit_code",
  ]) {
    mmVectorFields.push({ type: "filter", path: f });
  }
  const mmVectorIndexDef = {
    name: env.vectorIndexMultimodal,
    type: "vectorSearch",
    definition: { fields: mmVectorFields },
  };

  // ----- Atlas Search (lexical) index -----
  const searchIndexDef = {
    name: env.searchIndex,
    type: "search",
    definition: {
      // Custom Latin analyzer for handwritten English names (lowercase + fold
      // accents). CJK names use the built-in lucene.cjk analyzer (bigrams).
      analyzers: [
        {
          name: "hw_name_en",
          tokenizer: { type: "standard" },
          tokenFilters: [{ type: "lowercase" }, { type: "asciiFolding" }],
        },
      ],
      mappings: {
        dynamic: false,
        fields: {
          chunkText: { type: "string" },
          sourceText: { type: "string" },
          title: { type: "string" },
          exactTerms: { type: "string" },
          propertyAliases: { type: "string" },
          propertyName: { type: "string" },
          docType: { type: "string" },
          tags: { type: "string" },
          // iteration-2 lifecycle fields (token/bool so they are filterable).
          obsoleteFlag: { type: "boolean" },
          versionLabel: { type: "token" },
          versionGroupId: { type: "token" },
          documentId: { type: "token" },
          sourceFileType: { type: "token" },
          // Multi-dataset isolation (lexical arm): filter to one demo dataset.
          datasetId: { type: "token" },
          // FSI EXPANSION: dataset isolation + FSI address fields (lexical arm).
          metadataType: { type: "token" },
          raw_address: { type: "string" },
          district: { type: "token" },
          estate: { type: "string" },
          block: { type: "token" },
          unit_code: { type: "token" },
          building_name: { type: "string" },
          // Multilingual handwritten-name recall (HK tenancy signatures). The
          // nameText is indexed with a CJK analyzer AND a Latin multi-analyzer
          // so a tenancy is found by the tenant's Chinese OR English name.
          extractedHandwrittenNames: {
            type: "document",
            fields: {
              nameText: {
                type: "string",
                analyzer: "lucene.cjk",
                multi: {
                  en: { type: "string", analyzer: "hw_name_en" },
                },
              },
              lang: { type: "token" },
            },
          },
        },
      },
    },
  };

  // Pass --recreate to drop and rebuild existing indexes. Required when
  // switching EMBEDDING_STRATEGY (classic vector <-> autoEmbed are different
  // index shapes and cannot be edited in place).
  const recreate = process.argv.includes("--recreate");

  console.log(
    `Embedding strategy: ${env.embeddingStrategy}` +
      (useAtlasAutoEmbed
        ? ` (Atlas Automatic Embedding, model ${env.atlasAutoEmbedModel})`
        : " (explicit Voyage embeddings on 'embedding' field)")
  );

  const indexDefs: any[] = [vectorIndexDef, searchIndexDef];
  if (env.multimodalEmbedEnabled) {
    indexDefs.push(mmVectorIndexDef);
    console.log(
      `Multimodal comparison enabled: also creating "${env.vectorIndexMultimodal}" ` +
        `(explicit vector, ${env.multimodalEmbedDim}d, model ${env.multimodalEmbedModel}).`
    );
  }

  await createIndexesOn(col, indexDefs, recreate);

  // ----- Conversation-memory indexes (separate collection) -----
  // Atlas search indexes require the target collection to exist first.
  const db = await getDb();
  const collNames = (await db.listCollections().toArray()).map(
    (c: any) => c.name
  );
  if (!collNames.includes(env.conversationMessagesCollection)) {
    await db.createCollection(env.conversationMessagesCollection);
    console.log(
      `Created collection "${env.conversationMessagesCollection}".`
    );
  }
  const convCol = await getConversationMessagesCollection();
  const convVectorFields: any[] = useAtlasAutoEmbed
    ? [
        {
          type: "autoEmbed",
          path: "messageText",
          modality: "text",
          model: env.atlasAutoEmbedModel,
        },
      ]
    : [
        {
          type: "vector",
          path: "embedding",
          numDimensions: env.voyageEmbedDim,
          similarity: "cosine",
        },
      ];
  for (const f of ["conversationId", "role", "datasetId"]) {
    convVectorFields.push({ type: "filter", path: f });
  }
  const convVectorIndexDef = {
    name: env.convVectorIndex,
    type: "vectorSearch",
    definition: { fields: convVectorFields },
  };
  const convSearchIndexDef = {
    name: env.convSearchIndex,
    type: "search",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          messageText: { type: "string" },
          conversationId: { type: "token" },
          role: { type: "token" },
          datasetId: { type: "token" },
        },
      },
    },
  };
  console.log(
    `Conversation memory: creating "${env.convVectorIndex}" + "${env.convSearchIndex}".`
  );
  await createIndexesOn(
    convCol,
    [convVectorIndexDef, convSearchIndexDef],
    recreate
  );

  // ----- Signature image-embedding vector index (separate collection) -----
  if (!collNames.includes(env.signaturesCollection)) {
    await db.createCollection(env.signaturesCollection);
    console.log(`Created collection "${env.signaturesCollection}".`);
  }
  const sigCol = await getSignaturesCollection();
  const sigVectorIndexDef = {
    name: env.signatureVectorIndex,
    type: "vectorSearch",
    definition: {
      fields: [
        {
          type: "vector",
          path: "embedding",
          numDimensions: env.multimodalEmbedDim,
          similarity: "cosine",
        },
        { type: "filter", path: "signerName" },
      ],
    },
  };
  console.log(
    `Signature comparison: creating "${env.signatureVectorIndex}" ` +
      `(image embedding, ${env.multimodalEmbedDim}d, ${env.multimodalEmbedModel}).`
  );
  await createIndexesOn(sigCol, [sigVectorIndexDef], recreate);

  console.log(
    "\nNote: Atlas indexes take ~1-2 minutes to build. Check status in the Atlas UI " +
      "(Search tab) before running queries."
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
