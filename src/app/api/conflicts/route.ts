import { NextRequest, NextResponse } from "next/server";
import { listConflicts, resolveConflict } from "@/lib/conflict-detection";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get("status") as
      | import("@/lib/mongo").ConflictStatus
      | null;
    const conflicts = await listConflicts(undefined, status ?? undefined);
    return NextResponse.json({ conflicts });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, conflicts: [] },
      { status: 500 }
    );
  }
}

/** Resolve or ignore a conflict: { id, resolvedBy, status, resolutionNotes? } */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.id || !["resolved", "ignored"].includes(body.status)) {
      return NextResponse.json(
        { error: "id and status (resolved|ignored) required" },
        { status: 400 }
      );
    }
    await resolveConflict(
      body.id,
      body.resolvedBy ?? "reviewer",
      body.status,
      body.resolutionNotes
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
