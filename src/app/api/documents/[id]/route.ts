import { NextRequest, NextResponse } from "next/server";
import { getDocument, setReviewStatus, deleteDocument } from "@/lib/ingest";
import { markObsolete } from "@/lib/versioning";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const doc = await getDocument(params.id);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ document: doc });
}

/** Patch review status and/or obsolete flag. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();
    if (body.reviewStatus) {
      await setReviewStatus(params.id, body.reviewStatus, body.reviewNote);
    }
    if (typeof body.obsoleteFlag === "boolean") {
      await markObsolete(params.id, body.obsoleteFlag, body.supersededBy);
    }
    const doc = await getDocument(params.id);
    return NextResponse.json({ document: doc });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await deleteDocument(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
