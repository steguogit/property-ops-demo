import { NextRequest, NextResponse } from "next/server";
import { getDataset, renameDataset, deleteDataset } from "@/lib/datasets";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const dataset = await getDataset(params.id);
  if (!dataset) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ dataset });
}

/** Rename / edit description. Body: { name?, description? }. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();
    await renameDataset(params.id, body.name, body.description);
    const dataset = await getDataset(params.id);
    return NextResponse.json({ dataset });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Delete a dataset and all of its documents + chunks (built-ins protected). */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const removed = await deleteDataset(params.id);
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
