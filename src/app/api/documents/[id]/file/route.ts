import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDocument } from "@/lib/ingest";
import { getFileBucket } from "@/lib/mongo";

export const dynamic = "force-dynamic";

const MIME_BY_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  image: "image/*",
  csv: "text/csv",
  text: "text/plain; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Stream the ORIGINAL uploaded file from GridFS so the UI can preview the
 * actual content (image / PDF / text) rather than only the extracted text.
 * ?download=1 forces an attachment download.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await getDocument(params.id);
    if (!doc || !doc.originalFileId) {
      return NextResponse.json(
        { error: "no original file stored for this document" },
        { status: 404 }
      );
    }

    const bucket = await getFileBucket();
    const _id = new ObjectId(doc.originalFileId);

    // Confirm the file exists and get its length.
    const files = await bucket.find({ _id }).toArray();
    if (!files.length) {
      return NextResponse.json(
        { error: "original file missing from GridFS" },
        { status: 404 }
      );
    }
    const file = files[0];

    // Buffer the stream (demo files are small) and return as a web Response.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      bucket
        .openDownloadStream(_id)
        .on("data", (c: Buffer) => chunks.push(c))
        .on("error", reject)
        .on("end", () => resolve());
    });
    const body = Buffer.concat(chunks);

    const contentType =
      doc.mimeType ||
      file.contentType ||
      MIME_BY_TYPE[doc.sourceFileType] ||
      "application/octet-stream";

    const disposition =
      req.nextUrl.searchParams.get("download") === "1"
        ? "attachment"
        : "inline";

    return new NextResponse(body as any, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Content-Disposition": `${disposition}; filename="${encodeURIComponent(
          doc.sourceFileName
        )}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
