import { NextRequest, NextResponse } from "next/server";
import { listIngestionJobs } from "@/lib/ingest";

export const dynamic = "force-dynamic";

/**
 * Persisted ingestion history (processing trace per uploaded document), scoped
 * to the active demo dataset. Powers the collapsible "Processing history" view
 * in Upload & Review so a user can inspect past ingestions after a refresh —
 * not only during the live upload.
 */
export async function GET(req: NextRequest) {
  try {
    const datasetId = req.nextUrl.searchParams.get("datasetId") || undefined;
    const jobs = await listIngestionJobs(datasetId);
    return NextResponse.json({ jobs });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, jobs: [] },
      { status: 500 }
    );
  }
}
