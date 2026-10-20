// Knowledge retrieval: real Atlas Search (keyword) and Vector Search (semantic).
//   GET ?mode=keyword|semantic&q=...&equipmentType&docType&limit
// Honest unavailable state: if the required index is not queryable, returns
// available=false with setup guidance instead of a silent fallback.
import { NextRequest, NextResponse } from "next/server";
import {
  keywordSearch,
  semanticSearch,
  searchReadiness,
  keywordFacets,
} from "@/lib/bops/knowledge";
import { BOPS_INDEXES } from "@/lib/bops/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const mode = q.get("mode") === "semantic" ? "semantic" : "keyword";
  const query = (q.get("q") || "").trim();
  const equipmentType = q.get("equipmentType") || undefined;
  const docType = q.get("docType") || undefined;
  const limit = Math.min(Math.max(Number(q.get("limit")) || 6, 1), 20);

  if (!query) return NextResponse.json({ error: "q required" }, { status: 400 });

  const readiness = await searchReadiness();
  const needed = mode === "semantic" ? readiness.vector : readiness.lexical;
  if (needed !== "ready") {
    return NextResponse.json({
      mode,
      available: false,
      indexStatus: needed,
      index: mode === "semantic" ? BOPS_INDEXES.knowledgeVector : BOPS_INDEXES.knowledgeLexical,
      hits: [],
      message:
        needed === "building"
          ? "Search index is still building — try again in a minute."
          : needed === "absent"
          ? "Search index not found. Run `npm run bops:setup` to create it."
          : "Search is unavailable. Check Atlas Search status and connectivity.",
    });
  }

  try {
    const filters = {
      equipmentType: equipmentType as any,
      docType: docType as any,
    };
    const res =
      mode === "semantic"
        ? await semanticSearch(query, filters, limit)
        : await keywordSearch(query, filters, limit);
    // Keyword mode: also return live facet counts for facet-based navigation.
    let facets: any = null;
    if (mode === "keyword") {
      try {
        facets = await keywordFacets(query);
      } catch {
        facets = null; // facets optional; base search still works
      }
    }
    return NextResponse.json({
      mode,
      available: true,
      query,
      hits: res.hits,
      queryMs: res.ms,
      pipeline: res.pipeline,
      facets,
      scoreLabel:
        mode === "semantic"
          ? "retrieval similarity (not a diagnosis probability)"
          : "lexical relevance score",
    });
  } catch (e) {
    return NextResponse.json(
      { mode, available: false, hits: [], error: (e as Error).message },
      { status: 500 }
    );
  }
}
