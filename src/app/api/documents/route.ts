import { NextResponse } from "next/server";
import { listDocuments } from "@/lib/ingest";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const documents = await listDocuments();
    return NextResponse.json({ documents });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, documents: [] },
      { status: 500 }
    );
  }
}
