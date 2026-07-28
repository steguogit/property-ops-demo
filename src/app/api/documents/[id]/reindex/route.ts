import { NextRequest, NextResponse } from "next/server";
import { reindexDocument } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Re-extract + re-embed an existing document in place from its stored original,
 * using the current extraction config (e.g. upgraded OCR engine). Rebuilds
 * chunks + embeddings so stale, low-quality extractions become searchable.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const result = await reindexDocument(params.id);
    return NextResponse.json({
      document: result.document,
      chunkCount: result.chunkCount,
      job: result.job,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
