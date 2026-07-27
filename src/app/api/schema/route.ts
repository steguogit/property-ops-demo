import { NextResponse } from "next/server";
import { getCollection } from "@/lib/mongo";
import { env, isAtlasEmbedding } from "@/lib/env";

export const dynamic = "force-dynamic";

// JSON-Schema-style description of the chunk document, plus a live sample
// document pulled from Atlas, plus the index definitions in use.
const jsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Property operations chunk document",
  type: "object",
  required: ["docId", "docType", "title", "propertyName", "chunkText", "chunkIndex"],
  properties: {
    _id: { type: "string", description: "docId#chunkIndex" },
    docId: { type: "string", description: "Source document id, e.g. SOP-YOHO-ACCESS-001" },
    docType: {
      type: "string",
      enum: [
        "property_alias_master",
        "duty_roster",
        "incident_report",
        "sop",
        "faq",
        "contractor_procedure",
      ],
    },
    title: { type: "string" },
    propertyName: { type: "string", description: "Canonical property name" },
    propertyAliases: {
      type: "array",
      items: { type: "string" },
      description: "EN/ZH aliases, e.g. ['YOHO Mall', '形點']",
    },
    segment: {
      type: "string",
      enum: [
        "office_tower",
        "shopping_mall",
        "residential_estate",
        "luxury_residence",
        "master_data",
      ],
    },
    region: { type: "string" },
    language: { type: "array", items: { type: "string", enum: ["en", "zh"] } },
    audience: {
      type: "array",
      items: {
        type: "string",
        enum: ["internal_staff", "tenant", "resident", "contractor"],
      },
    },
    tags: { type: "array", items: { type: "string" } },
    sopTopic: { type: "string" },
    incidentType: { type: "string" },
    exactTerms: {
      type: "array",
      items: { type: "string" },
      description: "Entity / lexical keys boosted x5 in the Atlas Search index",
    },
    extractedFields: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Structured fields extracted from the source doc",
    },
    sourceText: { type: "string", description: "Full source document text" },
    chunkText: {
      type: "string",
      description: isAtlasEmbedding()
        ? "Indexed by Atlas autoEmbed (vector) + Atlas Search (lexical)"
        : "Indexed by Atlas Search; embedded into 'embedding' by Voyage",
    },
    chunkIndex: { type: "integer" },
    embedding: isAtlasEmbedding()
      ? {
          type: "null",
          description:
            "Not stored on the document — Atlas Automatic Embedding manages the vector internally from 'chunkText'.",
        }
      : {
          type: "array",
          items: { type: "number" },
          description: `${env.voyageEmbedDim}-dim Voyage embedding vector`,
        },
    sourceFileName: { type: "string" },
    updatedAt: { type: "string", format: "date" },
    // ----- iteration 2: source traceability / versioning / lifecycle -----
    documentId: {
      type: "string",
      description: "Links the chunk to its parent `documents` record (uploads).",
    },
    sourceFileType: {
      type: "string",
      enum: ["pdf", "docx", "xlsx", "csv", "pptx", "image", "text"],
    },
    versionLabel: { type: "string", description: "e.g. v2023.1" },
    versionGroupId: {
      type: "string",
      description: "Shared by all versions of the same logical document.",
    },
    obsoleteFlag: {
      type: "boolean",
      description:
        "True when superseded. Excluded by default (prefer newest) via { $ne: true }.",
    },
    effectiveFrom: { type: "string", format: "date" },
    ocrUsed: { type: "boolean", description: "True if text came from OCR." },
    relatedDocumentIds: { type: "array", items: { type: "string" } },
  },
};

const indexes = {
  vectorIndex: {
    name: env.vectorIndex,
    type: "vectorSearch",
    fields: isAtlasEmbedding()
      ? [
          {
            type: "autoEmbed",
            path: "chunkText",
            modality: "text",
            model: env.atlasAutoEmbedModel,
          },
          { type: "filter", path: "docType" },
          { type: "filter", path: "segment" },
          { type: "filter", path: "propertyName" },
        ]
      : [
          {
            type: "vector",
            path: "embedding",
            numDimensions: env.voyageEmbedDim,
            similarity: "cosine",
          },
          { type: "filter", path: "docType" },
          { type: "filter", path: "segment" },
        ],
  },
  searchIndex: {
    name: env.searchIndex,
    type: "search",
    mappings: {
      dynamic: false,
      fields: {
        chunkText: { type: "string" },
        sourceText: { type: "string" },
        title: { type: "string" },
        exactTerms: { type: "string" },
        propertyAliases: { type: "string" },
        propertyName: { type: "string" },
        docType: { type: "string" },
        tags: { type: "string" },
      },
    },
  },
};

export async function GET() {
  let sample: unknown = null;
  let count = 0;
  try {
    const col = await getCollection();
    count = await col.countDocuments();
    // Grab an alias-master sample (richest fields) for display.
    const doc =
      (await col.findOne(
        { docType: "property_alias_master" },
        { projection: { sourceText: 0 } }
      )) ?? (await col.findOne({}, { projection: { sourceText: 0 } }));
    if (doc && isAtlasEmbedding()) {
      // The vector lives inside Atlas, not on the doc — make that explicit.
      (doc as Record<string, unknown>).embedding =
        "<managed by Atlas Automatic Embedding>";
    }
    sample = doc;
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    database: env.dbName,
    collection: env.collectionName,
    documentCount: count,
    embeddingStrategy: env.embeddingStrategy,
    jsonSchema,
    indexes,
    sample,
    collections: {
      chunks: `${env.collectionName} — chunk-level documents (vector + lexical indexed)`,
      documents: `${env.documentsCollection} — one record per uploaded source file (metadata, extracted text, OCR, review/version status)`,
      property_aliases: `${env.aliasesCollection} — canonical property identity + EN/ZH/historical aliases`,
      document_versions: `${env.versionsCollection} — version groups linking revisions, marks current vs obsolete`,
      user_corrections: `${env.correctionsCollection} — human corrections applied at the data layer (pin/demote/term meaning/prefer version)`,
      ingestion_jobs: `${env.ingestionJobsCollection} — per-upload ingestion audit trail`,
    },
  });
}
