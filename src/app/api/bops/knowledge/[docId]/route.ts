// Fetch the full stored knowledge document from MongoDB (the "original
// document in the database"), mirroring the root demo's live sample-doc view.
import { NextRequest, NextResponse } from "next/server";
import { knowledgeCol } from "@/lib/bops/mongo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { docId: string } }
) {
  const docId = params.docId;
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });
  try {
    const col = await knowledgeCol();
    const doc = await col.findOne({ docId });
    if (!doc) return NextResponse.json({ error: "document not found" }, { status: 404 });
    return NextResponse.json({
      collection: "bops_knowledge",
      note:
        "Live document fetched from MongoDB. The vector is NOT stored on the " +
        "document — Atlas automatic embedding (voyage-4) indexes chunkText " +
        "server-side, so there is no embedding array to display.",
      document: doc,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
