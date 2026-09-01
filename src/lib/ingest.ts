import { Readable } from "stream";
import {
  getCollection,
  getDocumentsCollection,
  getIngestionJobsCollection,
  getFileBucket,
  deleteOriginalFile,
  DocumentDoc,
  ChunkDoc,
  IngestionJob,
} from "./mongo";
import { env, hasVoyage, isAtlasEmbedding, hasMultimodalEmbed } from "./env";
import {
  voyageEmbed,
  voyageEmbedMultimodal,
  voyageEmbedMultimodalImages,
} from "./voyage";
import { detectDocumentSignature } from "./signatures";
import { extractText, SourceFileType } from "./extract";
import { enrichPropertyAliases } from "./aliases";
import { chunkText } from "../../scripts/chunk";

// ---------------------------------------------------------------------------
// End-to-end ingestion: file buffer -> documents + document_chunks in Atlas.
//   1. extract text (+OCR / LLM-vision fallback, tracked)
//   2. enrich property aliases from the alias master
//   3. chunk
//   4. write a `documents` record (full metadata + preview)
//   5. write `chunks` with documentId traceability + version/obsolete fields
//   6. embed (explicit Voyage) or rely on Atlas auto-embedding
//   7. write an `ingestion_jobs` audit trail
// ---------------------------------------------------------------------------

export interface IngestInput {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  // optional metadata supplied by the uploader / review form
  title?: string;
  docType?: string;
  propertyName?: string;
  segment?: string;
  region?: string;
  language?: string[];
  audience?: string[];
  tags?: string[];
  exactTerms?: string[];
  propertyAliases?: string[];
  versionLabel?: string;
  versionGroupId?: string;
  effectiveFrom?: string;
  relatedDocumentIds?: string[];
  /** Re-index in place: reuse this documentId instead of generating a new one. */
  documentId?: string;
  /** Re-index: reuse an already-stored GridFS original (skip re-upload). */
  existingOriginalFileId?: string;
}

export interface IngestResult {
  document: DocumentDoc;
  chunkCount: number;
  job: IngestionJob;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "doc"
  );
}

function preview(text: string, n = 1200): string {
  const t = text.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export async function ingestFile(input: IngestInput): Promise<IngestResult> {
  const now = new Date().toISOString();
  const baseTitle = input.title || input.fileName.replace(/\.[^.]+$/, "");
  const documentId =
    input.documentId || `DOC-${Date.now()}-${slugify(baseTitle)}`;
  const jobId = `JOB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const steps: IngestionJob["steps"] = [];
  const stepTimer = (step: string) => {
    const t0 = Date.now();
    return (status: string, note?: string) =>
      steps.push({ step, status, ms: Date.now() - t0, note });
  };

  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();
  const jobsCol = await getIngestionJobsCollection();

  // --- 1. extract ---
  const endExtract = stepTimer("extract");
  const extraction = await extractText(
    input.buffer,
    input.fileName,
    input.mimeType
  );
  endExtract(
    extraction.lowConfidence ? "low_confidence" : "ok",
    `${extraction.method}${extraction.ocrUsed ? " (OCR)" : ""}`
  );

  const fileType: SourceFileType = extraction.fileType;

  // --- 2. enrich aliases ---
  const endAlias = stepTimer("enrich_aliases");
  const propertyName = input.propertyName || "Unassigned";
  const { canonicalName, aliases } = await enrichPropertyAliases(
    propertyName,
    input.propertyAliases ?? []
  );
  endAlias("ok", `${aliases.length} aliases`);

  // --- 3. chunk ---
  const endChunk = stepTimer("chunk");
  const text = extraction.text || "";
  const pageImages = extraction.pageImages ?? [];
  const chunks = text ? chunkText(text) : [];
  // A scanned PDF that OCR'd to real text is treated as a normal TEXT document
  // (keyword + text-vector searchable). Only when there's NO usable text do we
  // fall back to image-only chunks (cross-modal vector search only).
  const isPageImageDoc = pageImages.length > 0 && chunks.length === 0;
  endChunk(
    "ok",
    isPageImageDoc
      ? `${pageImages.length} page-image chunks`
      : `${chunks.length} chunks${pageImages.length ? " (+page images)" : ""}`
  );

  // Signature detection now runs ASYNCHRONOUSLY after persist (see below) so it
  // never blocks upload / embedding. Documents start as "pending".

  // Flag for review when extraction is weak or produced nothing searchable.
  const needsReview =
    !isPageImageDoc && (extraction.lowConfidence || chunks.length === 0);

  // --- 3b. store the ORIGINAL file in GridFS (for content preview) ---
  const endStore = stepTimer("store_original");
  let originalFileId: string | undefined = input.existingOriginalFileId;
  if (originalFileId) {
    // Re-index: the original is already in GridFS — reuse it.
    endStore("ok", "reused existing original (re-index)");
  } else {
    try {
      const bucket = await getFileBucket();
      originalFileId = await new Promise<string>((resolve, reject) => {
        const stream = bucket.openUploadStream(input.fileName, {
          contentType: input.mimeType,
          metadata: { documentId, fileType, uploadedAt: now },
        });
        Readable.from(input.buffer)
          .pipe(stream)
          .on("error", reject)
          .on("finish", () => resolve(stream.id.toString()));
      });
      endStore("ok", `GridFS ${(input.buffer.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      endStore("error", (e as Error).message);
    }
  }

  // --- 4. documents record ---
  const document: DocumentDoc = {
    _id: documentId,
    documentId,
    title: baseTitle,
    docType: input.docType || "uploaded_document",
    propertyName: canonicalName,
    propertyAliases: aliases,
    segment: input.segment,
    region: input.region,
    language: input.language ?? ["en"],
    audience: input.audience,
    tags: input.tags ?? [],
    exactTerms: input.exactTerms ?? [],
    sourceFileName: input.fileName,
    sourceFileType: fileType,
    mimeType: input.mimeType,
    originalFileId,
    fileSizeBytes: input.buffer.length,
    ocrUsed: extraction.ocrUsed,
    extractionMethod: extraction.method,
    extractionNote: extraction.note,
    extractedText: text,
    extractedTextPreview: preview(text),
    ...(extraction.ocr ? { ocr: extraction.ocr } : {}),
    ...(extraction.extractedHandwrittenNames?.length
      ? { extractedHandwrittenNames: extraction.extractedHandwrittenNames }
      : {}),
    chunkCount: chunks.length,
    embeddingStatus: isAtlasEmbedding()
      ? "auto_atlas"
      : hasVoyage()
      ? "voyage"
      : "none",
    versionLabel: input.versionLabel,
    versionGroupId: input.versionGroupId,
    obsoleteFlag: false,
    effectiveFrom: input.effectiveFrom,
    relatedDocumentIds: input.relatedDocumentIds ?? [],
    reviewStatus: "unreviewed",
    signatureStatus: "pending",
    status: needsReview ? "needs_review" : "ready",
    uploadedAt: now,
    updatedAt: now,
  };

  // --- 5. chunk records ---
  // Scanned/image-only PDFs produce ONE chunk per rendered page image (no text);
  // otherwise one chunk per text segment.
  const base = (i: number) => ({
    _id: `${documentId}#${i}`,
    docId: documentId,
    documentId,
    docType: document.docType,
    title: document.title,
    propertyName: canonicalName,
    propertyAliases: aliases,
    segment: document.segment ?? "uploaded",
    region: document.region,
    language: document.language,
    audience: document.audience,
    tags: document.tags,
    exactTerms: document.exactTerms,
    chunkIndex: i,
    sourceFileName: input.fileName,
    sourceFileType: fileType,
    versionLabel: input.versionLabel,
    versionGroupId: input.versionGroupId,
    obsoleteFlag: false,
    effectiveFrom: input.effectiveFrom,
    ocrUsed: extraction.ocrUsed,
    ...(extraction.extractedHandwrittenNames?.length
      ? { extractedHandwrittenNames: extraction.extractedHandwrittenNames }
      : {}),
    relatedDocumentIds: input.relatedDocumentIds ?? [],
    updatedAt: now,
  });

  const records: ChunkDoc[] = isPageImageDoc
    ? pageImages.map((_, i) => ({
        ...base(i),
        sourceText: "",
        chunkText: `${document.title} — page ${i + 1} (image)`,
        isPageImage: true,
        pageImageIndex: i,
      }))
    : chunks.map((c, i) => ({
        ...base(i),
        sourceText: text,
        chunkText: c,
      }));

  // --- 6. embed ---
  if (isPageImageDoc) {
    // Scanned PDF: embed each PAGE IMAGE directly with voyage-multimodal-3.5
    // (no OCR). Cross-modal vector search makes the pages findable by text.
    const endImg = stepTimer("embed_page_images");
    if (hasMultimodalEmbed()) {
      try {
        const vectors = await voyageEmbedMultimodalImages(
          pageImages.map((buffer) => ({ buffer, mime: "image/png" })),
          "document"
        );
        records.forEach((r, j) => (r.embeddingMultimodal = vectors[j]));
        document.embeddingStatus = "voyage";
        endImg("ok", `${pageImages.length} page images · ${env.multimodalEmbedModel}`);
      } catch (e) {
        document.embeddingStatus = "none";
        endImg("error", (e as Error).message);
      }
    } else {
      document.embeddingStatus = "none";
      endImg("skipped", "multimodal embedding not configured");
    }
  } else {
    const endEmbed = stepTimer("embed");
    if (isAtlasEmbedding()) {
      endEmbed("ok", "Atlas auto-embedding (no client call)");
    } else if (hasVoyage() && records.length) {
      try {
        const batchSize = 32;
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const vectors = await voyageEmbed(
            batch.map((r) => r.chunkText),
            "document"
          );
          batch.forEach((r, j) => (r.embedding = vectors[j]));
        }
        endEmbed("ok", `Voyage ${env.voyageEmbedModel}`);
      } catch (e) {
        endEmbed("error", (e as Error).message);
        document.embeddingStatus = "none";
      }
    } else {
      endEmbed("skipped", "no Voyage key & strategy!=atlas");
    }

    // --- 6b. secondary multimodal embedding (text) for model comparison ---
    if (hasMultimodalEmbed() && records.length) {
      const endMM = stepTimer("embed_multimodal");
      try {
        const batchSize = 32;
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const vectors = await voyageEmbedMultimodal(
            batch.map((r) => r.chunkText),
            "document"
          );
          batch.forEach((r, j) => (r.embeddingMultimodal = vectors[j]));
        }
        endMM("ok", `${env.multimodalEmbedModel}`);
      } catch (e) {
        endMM("error", (e as Error).message);
      }
    }

    // --- 6c. IMAGE-PIXEL multimodal embedding for image uploads ---
    // For a standalone image (png/jpg/webp), the chunk text is OCR-derived, so a
    // text `embeddingMultimodal` (6b) would only be findable by TEXT. To support
    // image-to-image search (query image → similar uploaded images), we OVERRIDE
    // the chunk's `embeddingMultimodal` with an embedding of the actual image
    // PIXELS. Enables `vector-multimodal` search to compare image-to-image.
    if (fileType === "image" && hasMultimodalEmbed() && records.length) {
      const endImgEmb = stepTimer("embed_image_pixels");
      try {
        const [vec] = await voyageEmbedMultimodalImages(
          [{ buffer: input.buffer, mime: input.mimeType || "image/png" }],
          "document"
        );
        // A standalone image is a single chunk; store the pixel vector there and
        // mark it so search/UI can treat it as an image chunk.
        records[0].embeddingMultimodal = vec;
        records[0].isPageImage = true;
        records[0].pageImageIndex = 0;
        document.embeddingStatus = "voyage";
        endImgEmb("ok", `image pixels · ${env.multimodalEmbedModel}`);
      } catch (e) {
        endImgEmb("error", (e as Error).message);
      }
    }
  }

  // --- 7. persist ---
  const endWrite = stepTimer("write");
  await docsCol.replaceOne({ documentId }, document as any, { upsert: true });
  await chunksCol.deleteMany({ documentId });
  if (records.length) await chunksCol.insertMany(records as any);
  endWrite("ok", `${records.length} chunks`);

  const job: IngestionJob = {
    _id: jobId,
    jobId,
    documentId,
    sourceFileName: input.fileName,
    status: document.status,
    steps,
    createdAt: now,
    updatedAt: new Date().toISOString(),
  };
  await jobsCol.insertOne(job as any);

  // --- 8. ASYNC signature detection (does not block the upload response) ---
  // Fire-and-forget: the doc is already persisted with signatureStatus="pending";
  // this updates it in the background. The UI polls while pending.
  void runSignatureDetectionAsync(
    documentId,
    input.buffer,
    input.mimeType ?? "",
    fileType,
    text
  );

  return { document, chunkCount: records.length, job };
}

/**
 * Background signature detection. Updates the document's signatureStatus /
 * signatureBox / signatureNote once done, and re-evaluates review state.
 * Errors are swallowed (best-effort) but recorded as status "unknown".
 */
async function runSignatureDetectionAsync(
  documentId: string,
  buffer: Buffer,
  mime: string,
  fileType: SourceFileType,
  text: string
): Promise<void> {
  try {
    const sig = await detectDocumentSignature(buffer, mime, fileType, text);
    const docsCol = await getDocumentsCollection();
    const doc = await docsCol.findOne({ documentId });
    if (!doc) return;
    // Escalate to needs_review if a signature is missing/unclear — but never
    // downgrade a doc a human already approved.
    const shouldReview =
      (sig.status === "unsigned" || sig.status === "unknown") &&
      doc.reviewStatus === "unreviewed";
    await docsCol.updateOne(
      { documentId },
      {
        $set: {
          signatureStatus: sig.status,
          signatureBox: sig.box,
          signatureNote: sig.note,
          status: shouldReview ? "needs_review" : doc.status,
          updatedAt: new Date().toISOString(),
        },
      }
    );
  } catch (e) {
    try {
      const docsCol = await getDocumentsCollection();
      await docsCol.updateOne(
        { documentId },
        {
          $set: {
            signatureStatus: "unknown",
            signatureNote: `signature detection failed: ${(e as Error).message}`,
            updatedAt: new Date().toISOString(),
          },
        }
      );
    } catch {
      /* give up */
    }
  }
}

export async function listDocuments(): Promise<DocumentDoc[]> {
  const col = await getDocumentsCollection();
  return col.find({}).sort({ uploadedAt: -1 }).limit(200).toArray();
}

export async function getDocument(
  documentId: string
): Promise<DocumentDoc | null> {
  const col = await getDocumentsCollection();
  return col.findOne({ documentId });
}

export async function setReviewStatus(
  documentId: string,
  reviewStatus: DocumentDoc["reviewStatus"],
  reviewNote?: string
): Promise<void> {
  const col = await getDocumentsCollection();
  await col.updateOne(
    { documentId },
    {
      $set: {
        reviewStatus,
        reviewNote,
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

export async function deleteDocument(documentId: string): Promise<void> {
  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();
  const doc = await docsCol.findOne({ documentId });
  await deleteOriginalFile(doc?.originalFileId);
  await chunksCol.deleteMany({ documentId });
  await docsCol.deleteOne({ documentId });
}

/**
 * Re-extract + re-embed an existing document IN PLACE from its stored GridFS
 * original, using the CURRENT extraction config (e.g. a better OCR engine).
 * Fixes stale documents ingested with a weaker OCR pass. Reuses the same
 * documentId and original file; rebuilds chunks + embeddings.
 */
export async function reindexDocument(
  documentId: string
): Promise<IngestResult> {
  const docsCol = await getDocumentsCollection();
  const doc = await docsCol.findOne({ documentId });
  if (!doc) throw new Error(`document ${documentId} not found`);
  if (!doc.originalFileId) {
    throw new Error(
      `document ${documentId} has no stored original file to re-index`
    );
  }

  // Pull the original bytes back from GridFS.
  const { ObjectId } = await import("mongodb");
  const bucket = await getFileBucket();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    bucket
      .openDownloadStream(new ObjectId(doc.originalFileId as string))
      .on("data", (c: Buffer) => chunks.push(c))
      .on("error", reject)
      .on("end", () => resolve());
  });
  const buffer = Buffer.concat(chunks);

  // Re-run the full pipeline in place, preserving id, metadata and original.
  return ingestFile({
    buffer,
    fileName: doc.sourceFileName,
    mimeType: doc.mimeType,
    title: doc.title,
    docType: doc.docType,
    propertyName: doc.propertyName,
    segment: doc.segment,
    region: doc.region,
    language: doc.language,
    audience: doc.audience,
    tags: doc.tags,
    exactTerms: doc.exactTerms,
    versionLabel: doc.versionLabel,
    versionGroupId: doc.versionGroupId,
    effectiveFrom: doc.effectiveFrom,
    relatedDocumentIds: doc.relatedDocumentIds,
    documentId: doc.documentId,
    existingOriginalFileId: doc.originalFileId,
  });
}
