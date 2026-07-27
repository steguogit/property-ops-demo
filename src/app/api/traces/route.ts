import { NextRequest, NextResponse } from "next/server";
import { listTraces } from "@/lib/policy-trace";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const limit = parseInt(
      req.nextUrl.searchParams.get("limit") ?? "50",
      10
    );
    const traces = await listTraces(undefined, limit);
    return NextResponse.json({ traces });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, traces: [] },
      { status: 500 }
    );
  }
}
