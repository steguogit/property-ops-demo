import { NextRequest, NextResponse } from "next/server";
import {
  runSearchEnhanced,
  imageVectorSearch,
  RetrievalMode,
  EnhancedSearchOptions,
} from "@/lib/retrieval";
import { explainForMode } from "@/lib/explain";
import { modelsForMode } from "@/lib/models";
import { datasetFilter } from "@/lib/datasets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_MODES: RetrievalMode[] = [
  "vector",
  "hybrid",
  "rerank",
  "vector-primary",
  "vector-multimodal",
];

/** Parse a data URL / raw base64 into { buffer, mime }. */
function parseImageInput(
  image: string
): { buffer: Buffer; mime: string } | null {
  if (!image || typeof image !== "string") return null;
  const m = image.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) {
    return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
  }
  // Fall back: treat as raw base64 of a PNG.
  try {
    return { mime: "image/png", buffer: Buffer.from(image, "base64") };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = body.limit ?? 8;

    // --- IMAGE query path (Compare tab's image-in-search-box) --------------
    // When an image is supplied, do image-to-image vector search against the
    // multimodal embeddings, and return the same { query, results } shape with a
    // single "vector-multimodal" result so the existing UI renders it.
    if (body.image) {
      const parsed = parseImageInput(body.image);
      if (!parsed) {
        return NextResponse.json(
          { error: "invalid image data" },
          { status: 400 }
        );
      }
      const t0 = Date.now();
      try {
        const imgDatasetId =
          typeof body.datasetId === "string" && body.datasetId
            ? body.datasetId
            : body.metadataType === "fsi"
            ? "fsi"
            : "property";
        const hits = await imageVectorSearch(
          parsed.buffer,
          parsed.mime,
          limit,
          datasetFilter(imgDatasetId)
        );
        return NextResponse.json({
          query: query || "(image query)",
          isImageQuery: true,
          results: [
            {
              mode: "vector-multimodal",
              ms: Date.now() - t0,
              hits,
              explain: null,
              models: modelsForMode("vector-multimodal" as any),
              appliedCorrections: null,
              expandedAliases: [],
              matchedProperties: [],
              policyPlan: null,
              traceId: null,
              error: null,
            },
          ],
        });
      } catch (e) {
        return NextResponse.json(
          { error: (e as Error).message },
          { status: 500 }
        );
      }
    }

    const modes: RetrievalMode[] = Array.isArray(body.modes)
      ? body.modes.filter((m: string) => VALID_MODES.includes(m as RetrievalMode))
      : VALID_MODES;

    const opts: EnhancedSearchOptions = {
      vectorWeight: body.vectorWeight,
      lexicalWeight: body.lexicalWeight,
      includeObsolete: body.includeObsolete ?? false,
      applyCorrections: body.applyCorrections ?? true,
      expandAliases: body.expandAliases ?? true,
      applyPolicies: body.applyPolicies ?? true,
      policyContext: body.policyContext,
      // MULTI-DATASET ISOLATION: scope retrieval to the active demo dataset.
      // Prefer explicit datasetId; fall back to the legacy metadataType mode.
      datasetId:
        typeof body.datasetId === "string" && body.datasetId
          ? body.datasetId
          : body.metadataType === "fsi"
          ? "fsi"
          : "property",
    };

    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    // Run requested modes in parallel; capture per-mode errors so one failure
    // doesn't break the whole comparison.
    const results = await Promise.all(
      modes.map(async (mode) => {
        const t0 = Date.now();
        const explain = explainForMode(mode, query, limit, {
          includeObsolete: opts.includeObsolete,
          applyCorrections: opts.applyCorrections,
          expandAliases: opts.expandAliases,
          applyPolicies: opts.applyPolicies,
        });
        try {
          const r = await runSearchEnhanced(mode, query, limit, opts);
          return {
            mode,
            ms: Date.now() - t0,
            hits: r.hits,
            explain,
            models: modelsForMode(mode as any),
            appliedCorrections: r.appliedCorrections,
            expandedAliases: r.expandedAliases,
            matchedProperties: r.matchedProperties,
            policyPlan: r.policyPlan,
            traceId: r.traceId,
            error: null,
          };
        } catch (e) {
          return {
            mode,
            ms: Date.now() - t0,
            hits: [],
            explain,
            models: modelsForMode(mode as any),
            appliedCorrections: null,
            expandedAliases: [],
            matchedProperties: [],
            policyPlan: null,
            traceId: null,
            error: (e as Error).message,
          };
        }
      })
    );

    return NextResponse.json({ query, results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
