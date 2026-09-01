import "./_loadEnv";
import { ObjectId } from "mongodb";
import {
  getCollection,
  getDocumentsCollection,
  getFileBucket,
} from "../src/lib/mongo";
import { env, hasMultimodalEmbed } from "../src/lib/env";
import { voyageEmbedMultimodalImages } from "../src/lib/voyage";

// ---------------------------------------------------------------------------
// Backfill IMAGE-PIXEL multimodal embeddings for already-uploaded IMAGE files.
//
// Normal ingestion OCRs an uploaded image to TEXT and embeds the text, so those
// chunks are only findable by TEXT. This script re-embeds the actual image
// PIXELS (from the original bytes in GridFS) into `embeddingMultimodal`, so the
// Compare tab's image-in-search-box (vector-multimodal) can do image-to-image
// search against them.
//
//   npm run embed-image-pixels          # all image-type documents
// ---------------------------------------------------------------------------

async function main() {
  if (!hasMultimodalEmbed()) {
    console.error(
      "Multimodal embedding is disabled or no model API key is set. " +
        "Set ATLAS_MODEL_API_KEY and MULTIMODAL_EMBED_ENABLED!=false."
    );
    process.exit(1);
  }

  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();
  const bucket = await getFileBucket();

  // Find all IMAGE documents that have an original file stored.
  const docs = await docsCol
    .find(
      { sourceFileType: "image", originalFileId: { $exists: true } },
      { projection: { documentId: 1, originalFileId: 1, mimeType: 1, title: 1 } }
    )
    .toArray();

  if (!docs.length) {
    console.log("No image-type documents with stored originals found.");
    process.exit(0);
  }

  console.log(
    `Re-embedding ${docs.length} image document(s) with ${env.multimodalEmbedModel} (image pixels)...`
  );

  let done = 0;
  let failed = 0;
  for (const d of docs as any[]) {
    try {
      // Download the original bytes from GridFS.
      const _id = new ObjectId(d.originalFileId);
      const chunksBuf: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        bucket
          .openDownloadStream(_id)
          .on("data", (c: Buffer) => chunksBuf.push(c))
          .on("error", reject)
          .on("end", () => resolve());
      });
      const buffer = Buffer.concat(chunksBuf);
      const mime = d.mimeType || "image/png";

      const [vec] = await voyageEmbedMultimodalImages(
        [{ buffer, mime }],
        "document"
      );

      // Update the document's chunk(s). A standalone image is a single chunk.
      const res = await chunksCol.updateMany(
        { documentId: d.documentId },
        {
          $set: {
            embeddingMultimodal: vec,
            isPageImage: true,
            pageImageIndex: 0,
          },
        }
      );
      done++;
      console.log(
        `  [${done}/${docs.length}] ${d.title || d.documentId} — ${res.modifiedCount} chunk(s)`
      );
    } catch (e) {
      failed++;
      console.error(
        `  FAILED ${d.title || d.documentId}: ${(e as Error).message}`
      );
    }
  }

  console.log(
    `Done. Re-embedded ${done} image doc(s), ${failed} failed. ` +
      `Ensure the "${env.vectorIndexMultimodal}" vector index exists (npm run create-indexes).`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
