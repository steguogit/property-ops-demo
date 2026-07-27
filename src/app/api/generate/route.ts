import { NextRequest, NextResponse } from "next/server";
import { generateFromHits } from "@/lib/rag";
import { explainForMode } from "@/lib/explain";
import type { RetrievalMode } from "@/lib/retrieval";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Generate a grounded LLM answer DIRECTLY from candidates the client already
 * retrieved (e.g. from the Compare tab), without re-running retrieval. The body
 * carries the query, the source mode, and the selected chunk identities.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const fromMode: RetrievalMode = body.mode ?? "rerank";
    const selection: { docId: string; chunkIndex: number }[] = Array.isArray(
      body.hits
    )
      ? body.hits
          .filter(
            (h: any) =>
              h && typeof h.docId === "string" && typeof h.chunkIndex === "number"
          )
          .map((h: any) => ({ docId: h.docId, chunkIndex: h.chunkIndex }))
      : [];

    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    if (!selection.length) {
      return NextResponse.json(
        { error: "hits (docId + chunkIndex) are required" },
        { status: 400 }
      );
    }

    const result = await generateFromHits(query, selection, fromMode);
    // Reuse the RAG explain card so the UI can show the generation pipeline.
    const explain = explainForMode("rag", query, selection.length, {});
    return NextResponse.json({ query, ...result, explain, reusedCandidates: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
