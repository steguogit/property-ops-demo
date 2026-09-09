import { NextRequest, NextResponse } from "next/server";
import { listDocuments } from "@/lib/ingest";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const datasetId = req.nextUrl.searchParams.get("datasetId") || undefined;
    const documents = await listDocuments(datasetId);
    return NextResponse.json({ documents });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, documents: [] },
      { status: 500 }
    );
  }
}
