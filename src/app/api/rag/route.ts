import { NextRequest, NextResponse } from "next/server";
import { runRag } from "@/lib/rag";
import { explainForMode } from "@/lib/explain";
import { modelsForMode } from "@/lib/models";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = body.limit ?? 6;
    const includeObsolete: boolean = body.includeObsolete ?? false;
    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const result = await runRag(query, limit, { includeObsolete });
    const explain = explainForMode("rag", query, limit, { includeObsolete });
    return NextResponse.json({
      query,
      ...result,
      explain,
      models: modelsForMode("rag"),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
