import { NextRequest, NextResponse } from "next/server";
import { enrollSignature, listSignatures } from "@/lib/signatures";

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

/** Enrol a reference signature (multipart: file + signerName + optional label). */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
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

    const f = file as File;
    const buffer = Buffer.from(await f.arrayBuffer());
    const mime = f.type || "image/png";
    if (!mime.startsWith("image/")) {
      return NextResponse.json(
        { error: "file must be an image" },
        { status: 400 }
      );
    }

    const signature = await enrollSignature({
      buffer,
      mime,
      fileName: f.name || "signature",
      signerName,
      label,
      cropRect,
    });
    // Don't ship the raw vector back to the client.
    const { embedding, ...rest } = signature;
    return NextResponse.json({ signature: rest });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
