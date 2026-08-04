import { NextRequest, NextResponse } from "next/server";
import {
  runSearchEnhanced,
  RetrievalMode,
  EnhancedSearchOptions,
} from "@/lib/retrieval";
import { explainForMode } from "@/lib/explain";
import { modelsForMode } from "@/lib/models";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_MODES: RetrievalMode[] = [
  "vector",
  "hybrid",
  "rerank",
  "vector-primary",
  "vector-multimodal",
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = body.limit ?? 8;
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
      // FSI EXPANSION: dataset isolation driven by the global industry mode.
      metadataType: body.metadataType === "fsi" ? "fsi" : "property",
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
