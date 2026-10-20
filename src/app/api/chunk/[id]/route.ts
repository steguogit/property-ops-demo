import { NextResponse } from "next/server";
import { getCollection } from "@/lib/mongo";
import { env, isAtlasEmbedding } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Fetch the ACTUAL MongoDB document for a single chunk so the UI can show the
 * real document shape in a dialog. The incoming id is "docId#chunkIndex" (the
 * convention the UI builds from a hit). We look it up robustly:
 *   1. exact `_id` match (covers the curated `${docId}#0` chunk), then
 *   2. fall back to `{ docId, chunkIndex }` — because extra source chunks are
 *      stored with ids like `${docId}#src1` while their chunkIndex is 1, so
 *      reconstructing `${docId}#1` would miss them.
 *
 * Large embedding vectors are replaced with a compact placeholder so the JSON
 * stays readable (and the payload small) while still revealing the field shape.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const id = decodeURIComponent(params.id);
  try {
    const col = await getCollection();

    let doc = (await col.findOne({ _id: id as never })) as Record<
      string,
      unknown
    > | null;

    // Fallback: split "docId#chunkIndex" and match on the fields directly.
    if (!doc) {
      const hashAt = id.lastIndexOf("#");
      if (hashAt > 0) {
        const docId = id.slice(0, hashAt);
        const chunkIndex = Number(id.slice(hashAt + 1));
        if (Number.isFinite(chunkIndex)) {
          doc = (await col.findOne({ docId, chunkIndex } as never)) as Record<
            string,
            unknown
          > | null;
        }
      }
    }

    if (!doc) {
      return NextResponse.json(
        { error: `No document found for "${id}"` },
        { status: 404 }
      );
    }

    // Keep the JSON human-readable: summarise big vectors rather than dumping
    // thousands of floats.
    if (isAtlasEmbedding()) {
      doc.embedding = "<managed by Atlas Automatic Embedding>";
    } else if (Array.isArray(doc.embedding)) {
      doc.embedding = `<${(doc.embedding as number[]).length}-dim vector>`;
    }
    if (Array.isArray(doc.embeddingMultimodal)) {
      doc.embeddingMultimodal = `<${
        (doc.embeddingMultimodal as number[]).length
      }-dim multimodal vector>`;
    }

    return NextResponse.json({
      database: env.dbName,
      collection: env.collectionName,
      document: doc,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
