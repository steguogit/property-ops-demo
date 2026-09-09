import { NextRequest, NextResponse } from "next/server";
import { ingestFile } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Multipart upload + full ingestion. Accepts a `file` plus optional metadata
 * fields. Returns the created documents record, chunk count, and the ingestion
 * job audit trail so the review UI can show exactly what happened.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const arrayBuf = await (file as File).arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const arr = (k: string) => {
      const v = str(k);
      return v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    };

    const result = await ingestFile({
      buffer,
      fileName: (file as File).name || "upload",
      mimeType: (file as File).type,
      datasetId: str("datasetId"),
      title: str("title"),
      docType: str("docType"),
      propertyName: str("propertyName"),
      segment: str("segment"),
      region: str("region"),
      language: arr("language"),
      audience: arr("audience"),
      tags: arr("tags"),
      exactTerms: arr("exactTerms"),
      versionLabel: str("versionLabel"),
      versionGroupId: str("versionGroupId"),
      effectiveFrom: str("effectiveFrom"),
      relatedDocumentIds: arr("relatedDocumentIds"),
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
