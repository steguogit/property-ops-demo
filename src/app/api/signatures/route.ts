import { NextRequest, NextResponse } from "next/server";
import {
  enrollSignature,
  enrollSignatureRegions,
  listSignatures,
} from "@/lib/signatures";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const signatures = await listSignatures();
    return NextResponse.json({ signatures });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Enrol reference signature(s) (multipart).
 *
 * Two modes:
 *   - MULTI:  `regions` = JSON array of { signerName, label?, cropRect } →
 *             each region becomes its own specimen (tenant + landlord, etc.).
 *   - SINGLE: legacy `signerName` + optional `label` + optional `cropRect`.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    const f = file as File;
    const buffer = Buffer.from(await f.arrayBuffer());
    const mime = f.type || "image/png";
    if (!mime.startsWith("image/")) {
      return NextResponse.json(
        { error: "file must be an image" },
        { status: 400 }
      );
    }

    // MULTI-region enrolment.
    const regionsRaw = form.get("regions") as string | null;
    if (regionsRaw) {
      let parsed: any[];
      try {
        parsed = JSON.parse(regionsRaw);
      } catch {
        return NextResponse.json(
          { error: "regions must be valid JSON" },
          { status: 400 }
        );
      }
      const regions = (Array.isArray(parsed) ? parsed : [])
        .filter(
          (r) =>
            r &&
            typeof r.signerName === "string" &&
            r.signerName.trim() &&
            r.cropRect &&
            typeof r.cropRect.x === "number"
        )
        .map((r) => ({
          signerName: r.signerName.trim(),
          label: (r.label || "").trim() || undefined,
          cropRect: r.cropRect,
        }));
      if (regions.length === 0) {
        return NextResponse.json(
          { error: "at least one named region is required" },
          { status: 400 }
        );
      }
      const docs = await enrollSignatureRegions({
        buffer,
        mime,
        fileName: f.name || "signature",
        regions,
      });
      const signatures = docs.map(({ embedding, ...rest }) => rest);
      return NextResponse.json({ signatures });
    }

    // SINGLE-region (legacy) enrolment.
    const signerName = (form.get("signerName") as string | null)?.trim();
    if (!signerName) {
      return NextResponse.json(
        { error: "signerName is required" },
        { status: 400 }
      );
    }
    const label = (form.get("label") as string | null)?.trim() || undefined;
    const cropRaw = form.get("cropRect") as string | null;
    let cropRect = null;
    if (cropRaw) {
      try {
        const c = JSON.parse(cropRaw);
        if (c && typeof c.x === "number") cropRect = c;
      } catch {
        /* ignore bad crop */
      }
    }

    const signature = await enrollSignature({
      buffer,
      mime,
      fileName: f.name || "signature",
      signerName,
      label,
      cropRect,
    });
    const { embedding, ...rest } = signature;
    return NextResponse.json({ signature: rest });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
