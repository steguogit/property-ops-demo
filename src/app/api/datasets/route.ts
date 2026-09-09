import { NextRequest, NextResponse } from "next/server";
import { listDatasets, createDataset } from "@/lib/datasets";

export const dynamic = "force-dynamic";

/** List all demo datasets (with live document/chunk counts). */
export async function GET() {
  try {
    const datasets = await listDatasets();
    return NextResponse.json({ datasets });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, datasets: [] },
      { status: 500 }
    );
  }
}

/** Create a new demo dataset. Body: { name, description? }. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name: string = (body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const dataset = await createDataset(name, body.description);
    return NextResponse.json({ dataset });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
