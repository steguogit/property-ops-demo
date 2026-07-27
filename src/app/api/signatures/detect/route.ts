import { NextRequest, NextResponse } from "next/server";
import { detectSignatureRegion } from "@/lib/signatures";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Auto-detect the signature bounding box in an uploaded image (multipart). */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    const f = file as File;
    const mime = f.type || "image/png";
    const buffer = Buffer.from(await f.arrayBuffer());
    const result = await detectSignatureRegion(buffer, mime);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
