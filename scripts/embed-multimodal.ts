import "./_loadEnv";
import { getCollection } from "../src/lib/mongo";
import { env, hasMultimodalEmbed } from "../src/lib/env";
import { voyageEmbedMultimodal } from "../src/lib/voyage";

// ---------------------------------------------------------------------------
// Backfill the secondary voyage-multimodal-3.5 embedding for existing chunks.
//
// Reads every chunk in the collection, embeds its `chunkText` with the
// multimodal model, and $sets the `embeddingMultimodal` field. Idempotent:
// by default it only processes chunks that don't yet have the field. Pass
// --all to re-embed everything.
//
//   npm run embed-multimodal          # only chunks missing the field
//   npm run embed-multimodal -- --all # re-embed all chunks
// ---------------------------------------------------------------------------

async function main() {
  if (!hasMultimodalEmbed()) {
    console.error(
      "Multimodal embedding is disabled or no model API key is set. " +
        "Set ATLAS_MODEL_API_KEY and MULTIMODAL_EMBED_ENABLED!=false."
    );
    process.exit(1);
  }

  const all = process.argv.includes("--all");
  const col = await getCollection();

  const filter = all ? {} : { embeddingMultimodal: { $exists: false } };
  const chunks = await col
    .find(filter, { projection: { _id: 1, chunkText: 1 } })
    .toArray();

  if (!chunks.length) {
    console.log(
      all
        ? "No chunks found."
        : "All chunks already have a multimodal embedding. Use --all to re-embed."
    );
    process.exit(0);
  }

  console.log(
    `Embedding ${chunks.length} chunk(s) with ${env.multimodalEmbedModel} ` +
      `(${all ? "re-embed all" : "missing only"})...`
  );

  const batchSize = 32;
  let done = 0;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await voyageEmbedMultimodal(
      batch.map((c: any) => c.chunkText ?? ""),
      "document"
    );
    // Persist each vector.
    await Promise.all(
      batch.map((c: any, j: number) =>
        col.updateOne(
          { _id: c._id },
          { $set: { embeddingMultimodal: vectors[j] } }
        )
      )
    );
    done += batch.length;
    console.log(`  embedded ${done}/${chunks.length}`);
  }

  console.log(
    `Done. Backfilled ${done} chunk(s). Ensure the "${env.vectorIndexMultimodal}" ` +
      "vector index exists (npm run create-indexes)."
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
