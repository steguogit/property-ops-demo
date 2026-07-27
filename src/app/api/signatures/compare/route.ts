import { NextRequest, NextResponse } from "next/server";
import { compareSignature } from "@/lib/signatures";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Compare a query signature image against enrolled specimens (multipart). */
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
    const cropRaw = form.get("cropRect") as string | null;
    let cropRect = null;
    if (cropRaw) {
      try {
        const c = JSON.parse(cropRaw);
        if (c && typeof c.x === "number") cropRect = c;
      } catch {
        /* ignore */
      }
    }
    const { matches } = await compareSignature(buffer, mime, 5, cropRect);
    return NextResponse.json({
      matches,
      thresholds: {
        match: env.signatureMatchThreshold,
        review: env.signatureReviewThreshold,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
