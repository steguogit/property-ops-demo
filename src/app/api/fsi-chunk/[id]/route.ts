// ===========================================================================
// FSI EXPANSION — fetch a single raw chunk document by _id (lab viewer).
//
// Returns the FULL raw MongoDB document from the `chunks` collection so the
// Floor-Ranking Lab can show exactly what is stored (structured FSI fields,
// metadataType, location, etc.). Read-only.
// ===========================================================================

import { NextRequest, NextResponse } from "next/server";
import { getCollection } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const col = await getCollection();
    // Do not return the raw embedding arrays (huge, noisy); show everything else.
    const doc = await col.findOne(
      { _id: params.id as any },
      { projection: { embedding: 0, embeddingMultimodal: 0 } }
    );
    if (!doc) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ document: doc });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "lookup failed" },
      { status: 500 }
    );
  }
}
