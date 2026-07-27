import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getFileBucket, getSignaturesCollection } from "@/lib/mongo";

export const dynamic = "force-dynamic";

/** Stream an enrolled signature image from GridFS (for preview / thumbnails). */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const col = await getSignaturesCollection();
    const doc = await col.findOne({ signatureId: params.id });
    if (!doc || !doc.originalFileId) {
      return NextResponse.json(
        { error: "no image stored for this signature" },
        { status: 404 }
      );
    }
    const bucket = await getFileBucket();
    const _id = new ObjectId(doc.originalFileId);
    const files = await bucket.find({ _id }).toArray();
    if (!files.length) {
      return NextResponse.json(
        { error: "image missing from GridFS" },
        { status: 404 }
      );
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      bucket
        .openDownloadStream(_id)
        .on("data", (c: Buffer) => chunks.push(c))
        .on("error", reject)
        .on("end", () => resolve());
    });
    const body = Buffer.concat(chunks);
    return new NextResponse(body as any, {
      status: 200,
      headers: {
        "Content-Type": doc.mimeType || files[0].contentType || "image/png",
        "Content-Length": String(body.length),
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
