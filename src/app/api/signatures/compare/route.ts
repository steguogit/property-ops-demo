import { NextRequest, NextResponse } from "next/server";
import { compareSignatureRegions } from "@/lib/signatures";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Compare a query signature image against enrolled specimens (multipart).
 *
 * Accepts EITHER:
 *   - cropRects: JSON array of regions → compare each region, best match per region
 *   - cropRect:  legacy single region  → treated as a one-element array
 *   - neither:   auto-detect all regions in the image
 *
 * Response:
 *   - regions:  per-region results (regionIndex, cropRect, matches[], best)
 *   - matches:  flat best-per-region list, kept for backward compatibility
 *   - thresholds
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    const f = file as File;
    const mime = f.type || "image/png";
    if (!mime.startsWith("image/")) {
      return NextResponse.json(
        { error: "file must be an image" },
        { status: 400 }
      );
    }
    const buffer = Buffer.from(await f.arrayBuffer());

    // Parse regions: prefer cropRects[], fall back to a single cropRect.
    let regions: any[] | null = null;
    const cropRectsRaw = form.get("cropRects") as string | null;
    const cropRaw = form.get("cropRect") as string | null;
    if (cropRectsRaw) {
      try {
        const arr = JSON.parse(cropRectsRaw);
        if (Array.isArray(arr))
          regions = arr.filter((c) => c && typeof c.x === "number");
      } catch {
        /* ignore */
      }
    } else if (cropRaw) {
      try {
        const c = JSON.parse(cropRaw);
        if (c && typeof c.x === "number") regions = [c];
      } catch {
        /* ignore */
      }
    }

    const { regions: regionResults } = await compareSignatureRegions(
      buffer,
      mime,
      regions,
      5
    );

    // Backward-compatible flat list: the best match for each region.
    const flatMatches = regionResults
      .map((r) => r.best)
      .filter((m): m is NonNullable<typeof m> => !!m);

    return NextResponse.json({
      regions: regionResults,
      matches: flatMatches,
      thresholds: {
        match: env.signatureMatchThreshold,
        review: env.signatureReviewThreshold,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
