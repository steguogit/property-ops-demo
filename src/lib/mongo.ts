import { MongoClient, Collection, Db, GridFSBucket } from "mongodb";
import { env, assertMongo } from "./env";

// Reuse a single client across hot-reloads / serverless invocations.
let clientPromise: Promise<MongoClient> | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __propOpsMongoClient: Promise<MongoClient> | undefined;
}

export function getClient(): Promise<MongoClient> {
  assertMongo();
  if (process.env.NODE_ENV === "production") {
    if (!clientPromise) {
      clientPromise = new MongoClient(env.mongoUri).connect();
    }
    return clientPromise;
  }
  if (!global.__propOpsMongoClient) {
    global.__propOpsMongoClient = new MongoClient(env.mongoUri).connect();
  }
  return global.__propOpsMongoClient;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env.dbName);
}

export interface ChunkDoc {
  _id?: string;
  docId: string;
  docType: string;
  title: string;
  propertyName: string;
  propertyAliases: string[];
  segment: string;
  region?: string;
  language: string[];
  audience?: string[];
  tags: string[];
  sopTopic?: string;
  incidentType?: string;
  sourceText: string;
  chunkText: string;
  chunkIndex: number;
  exactTerms: string[];
  extractedFields?: Record<string, string>;
  embedding?: number[];
  /**
   * Secondary embedding from voyage-multimodal-3.5, generated client-side and
   * stored explicitly so its vector-search ranking can be compared against the
   * primary voyage-4 Atlas auto-embedding. Indexed by `vector_index_mm`.
   */
  embeddingMultimodal?: number[];
  sourceFileName?: string;
  updatedAt?: string;

  // ----- Iteration 2: source traceability, versioning, lifecycle -----
  /** Links a chunk back to its parent `documents` record (uploaded files). */
  documentId?: string;
  sourceFileType?: string;
  /** Human-readable version label, e.g. "v2023.1" or "2016 edition". */
  versionLabel?: string;
  /** Documents that supersede each other share a versionGroupId. */
  versionGroupId?: string;
  /** True when a newer version supersedes this one. */
  obsoleteFlag?: boolean;
  supersededBy?: string;
  /** ISO date the version became effective; drives "prefer newest". */
  effectiveFrom?: string;
  /** True when text came from OCR (scanned / image content). */
  ocrUsed?: boolean;
  /**
   * Handwritten names recovered from this document by the multimodal pass
   * (HK tenancy signatures: zh / en / mixed). Duplicated onto every chunk of
   * the document so the Atlas Search lexical arm can recall a tenancy by the
   * tenant's Chinese OR English handwritten name. Illegible entries are kept
   * as "[無法識別手寫姓名]".
   */
  extractedHandwrittenNames?: {
    nameText: string;
    lang: "zh" | "en" | "mixed" | "unknown";
    bbox: [number, number][];
    sourceConfidence: number;
  }[];
  /**
   * For scanned/image-only PDFs: this chunk represents a rendered PAGE IMAGE
   * embedded directly with voyage-multimodal-3.5 (no OCR). Vector-searchable via
   * `embeddingMultimodal` cross-modally against text queries. `pageImageIndex`
   * is the 0-based page number; `chunkText` holds a short placeholder label.
   */
  isPageImage?: boolean;
  pageImageIndex?: number;
  /** Other documents this one references (multi-doc workflows). */
  relatedDocumentIds?: string[];

  // ----- FSI EXPANSION -----
  /**
   * Dataset marker isolating the two demo modes within one collection:
   * "property" (default, original data) | "fsi" (address verification).
   * Absent == treated as "property" for backwards compatibility.
   */
  metadataType?: "property" | "fsi";
  /** FSI: original, un-normalised address string (also stored as chunkText). */
  raw_address?: string;
  /** FSI: Hong Kong administrative district. */
  district?: string;
  /** FSI: estate / building short name. */
  estate?: string;
  /** FSI: block / tower designation (e.g. "Block 2", "座 A"). */
  block?: string;
  /** FSI: numeric floor — REQUIRED for FSI docs; drives exact-match rank boost. */
  floor_num?: number;
  /** FSI: unit / flat / room code (e.g. "A", "Flat 5", "室1203"). */
  unit_code?: string;
  /** FSI: full building name. */
  building_name?: string;
  /**
   * FSI: GeoJSON point [lng, lat] for 2dsphere / $geoNear pre-filtering (Phase 4).
   * Populated with synthetic HK coordinates by the FSI seed.
   */
  location?: { type: "Point"; coordinates: [number, number] };
}

/** Status of an uploaded source file as it moves through ingestion. */
export type IngestionStatus =
  | "uploaded"
  | "extracting"
  | "chunking"
  | "embedding"
  | "ready"
  | "needs_review"
  | "error";

/** One record per uploaded source file. */
export interface DocumentDoc {
  _id?: string; // documentId, e.g. "DOC-<timestamp>-<slug>"
  documentId: string;
  title: string;
  docType: string;
  propertyName: string;
  propertyAliases: string[];
  segment?: string;
  region?: string;
  language: string[];
  audience?: string[];
  tags: string[];
  exactTerms: string[];
  // Source file metadata
  sourceFileName: string;
  sourceFileType: string; // pdf | docx | xlsx | csv | pptx | image | text
  mimeType?: string; // original upload MIME type (for preview content-type)
  /** GridFS file id of the stored original (string form of ObjectId). */
  originalFileId?: string;
  fileSizeBytes?: number;
  ocrUsed: boolean;
  extractionMethod?: string; // e.g. "pdf-parse", "mammoth", "tesseract+llm"
  extractionNote?: string; // caveats, e.g. "diagram-heavy PPTX, partial text"
  extractedText: string;
  extractedTextPreview?: string;
  chunkCount: number;
  embeddingStatus: "pending" | "auto_atlas" | "voyage" | "none";
  // Versioning / lifecycle
  versionLabel?: string;
  versionGroupId?: string;
  obsoleteFlag: boolean;
  supersededBy?: string;
  effectiveFrom?: string;
  relatedDocumentIds: string[];
  // Human review
  reviewStatus: "unreviewed" | "approved" | "needs_correction" | "corrected";
  reviewNote?: string;
  // ----- Signature analysis (auto-detected on ingestion) -----
  /**
   *  signed          — a handwritten signature was detected
   *  unsigned        — a signature line/field exists but is empty -> needs review
   *  not_required    — the document type doesn't call for a signature
   *  unknown         — could not be analysed (non-visual file / detection failed)
   */
  signatureStatus?:
    | "pending"
    | "signed"
    | "unsigned"
    | "not_required"
    | "unknown";
  /** Normalized bounding box (0..1) of the detected signature, if any. */
  signatureBox?: { x: number; y: number; w: number; h: number } | null;
  /** Short model explanation of the signature classification. */
  signatureNote?: string;
  // Pipeline status
  status: IngestionStatus;
  errorMessage?: string;
  uploadedAt: string;
  updatedAt: string;

  // ----- External PaddleOCR (backend-separated OCR) — incremental add-on -----
  // Present only when the file was OCR'd via the external PaddleOCR microservice.
  // All existing fields above are preserved; this is purely additive.
  ocr?: {
    /** Raw (unsorted) layout blocks: bbox + direction + confidence + text. */
    blocks: {
      bbox: [number, number][];
      direction: "vertical" | "horizontal";
      text: string;
      confidence: number;
    }[];
    /** Reorder-then-join text (mixed-orientation reading order) for embedding. */
    fullText: string;
    ocrVersion: string; // e.g. "paddle_layout_v1"
  };

  // ----- Multilingual handwritten-name recognition (HK tenancy signatures) --
  // Populated when the multimodal handwriting pass re-read signature/name
  // blocks. ONE multimodal model handles zh / en / mixed names — no per-language
  // model split. Illegible names are kept as "[無法識別手寫姓名]" (never dropped).
  // Indexed for multilingual recall via Atlas Search on
  // `extractedHandwrittenNames.nameText` so a tenant is found by their Chinese
  // OR English name.
  extractedHandwrittenNames?: {
    nameText: string;
    lang: "zh" | "en" | "mixed" | "unknown";
    bbox: [number, number][];
    sourceConfidence: number;
  }[];
}

/** Canonical property identity with historical + bilingual aliases. */
export interface PropertyAliasDoc {
  _id?: string; // canonical slug
  canonicalName: string;
  officialChineseName?: string;
  aliases: string[]; // all known names incl. EN/ZH/historical
  historicalNames?: { name: string; usedFrom?: string; usedUntil?: string }[];
  region?: string;
  segment?: string;
  note?: string;
  updatedAt: string;
}

/** Groups document versions and records which is current. */
export interface DocumentVersionGroup {
  _id?: string; // versionGroupId
  versionGroupId: string;
  title: string;
  propertyName?: string;
  currentDocumentId?: string;
  versions: {
    documentId: string;
    versionLabel: string;
    effectiveFrom?: string;
    obsolete: boolean;
    note?: string;
  }[];
  updatedAt: string;
}

/** A human correction applied at the data layer (never via prompt edits). */
export type CorrectionType =
  | "term_meaning" // a term/alias means X (adds boost + RAG context)
  | "wrong_interpretation" // mark a chunk/answer as wrongly interpreted
  | "prefer_source" // pin a docId as the authoritative source for a query
  | "demote_source" // push a docId down for a query
  | "prefer_version"; // prefer a specific document version

export interface UserCorrection {
  _id?: string;
  correctionId: string;
  type: CorrectionType;
  // What it applies to
  query?: string; // the query/topic the correction is scoped to (optional = global)
  term?: string; // for term_meaning
  correctedMeaning?: string; // for term_meaning
  propertyName?: string;
  // Targets
  targetDocId?: string; // prefer/demote/prefer_version
  preferredVersionLabel?: string;
  // Provenance
  note?: string;
  createdBy?: string;
  active: boolean;
  createdAt: string;
}

export interface IngestionJob {
  _id?: string;
  jobId: string;
  documentId: string;
  sourceFileName: string;
  status: IngestionStatus;
  steps: { step: string; status: string; ms?: number; note?: string }[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

// ===========================================================================
// KNOWLEDGE POLICY LAYER
//
// A governed, human-approved correction layer. This is deliberately NOT a
// static rule engine and NOT a fully-AI dynamic system. The split of concerns:
//
//   AI ASSISTS (non-authoritative):
//     - interprets raw feedback,
//     - drafts CorrectionProposal records,
//     - suggests scope / aliases / canonical meaning / rationale,
//     - flags likely conflicts, and estimates impact.
//
//   HUMANS GOVERN (authoritative):
//     - review, edit, approve, or reject proposals.
//     - Only an approved proposal becomes an active KnowledgePolicy.
//
//   RUNTIME APPLIES DETERMINISTICALLY (source of truth = approved policy):
//     - the same query + metadata + policy-set + index always yields the same
//       policy application. The LLM never re-decides the meaning of an approved
//       business term at runtime; it consumes the approved canonicalMeaning.
//
// Entity lifecycle:
//   CorrectionFeedback -> CorrectionProposal -> KnowledgePolicy
//                                            -> PolicyConflict (detection)
//                                            -> PolicyImpactSimulation (eval)
//   KnowledgePolicy (applied at query time) -> PolicyApplicationTrace
// ===========================================================================

/** The eight policy/proposal types shared by proposals and approved policies. */
export type PolicyType =
  | "terminology_mapping" // a term/alias maps to a canonical meaning
  | "query_expansion" // add aliases / expansions to the query
  | "source_boost" // raise specific docIds
  | "source_demotion" // lower specific docIds
  | "document_version_preference" // prefer a specific / latest version
  | "document_exclusion" // never surface specific docIds
  | "intent_mapping" // map a query pattern to an intent
  | "answer_instruction"; // grounding instruction for the answer step

export type FeedbackType =
  | "wrong_term_interpretation"
  | "missing_document"
  | "wrong_document_rank"
  | "outdated_document"
  | "source_should_be_boosted"
  | "source_should_be_demoted"
  | "incorrect_answer"
  | "other";

/** Raw human feedback on a bad answer / retrieval / interpretation. */
export interface CorrectionFeedback {
  _id?: string; // = id
  id: string;
  tenantId: string;
  propertyId?: string | null;
  department?: string | null;
  userId: string;
  conversationId?: string | null;
  queryText: string;
  answerText?: string | null;
  retrievedDocumentIds?: string[] | null;
  feedbackType: FeedbackType;
  feedbackText: string;
  language?: string | null;
  /** Set once proposals have been generated from this feedback. */
  processedAt?: string | null;
  createdAt: string;
}

/** Scope descriptor — where a policy/proposal applies. Narrow by default. */
export interface PolicyScope {
  propertyIds?: string[] | null;
  departmentIds?: string[] | null;
  userRoleIds?: string[] | null;
  languages?: string[] | null;
  documentTypeIds?: string[] | null;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
}

/** Conditions that must match the incoming query for a policy to apply. */
export interface PolicyMatchConditions {
  terms?: string[] | null;
  aliases?: string[] | null;
  intents?: string[] | null;
  queryPatterns?: string[] | null; // regex or substring patterns
  documentIds?: string[] | null;
  metadataFilters?: Record<string, unknown> | null;
}

/** Deterministic actions applied when a policy matches. */
export interface PolicyActions {
  canonicalTerm?: string | null;
  canonicalMeaning?: string | null;
  expandQueryWith?: string[] | null;
  boostDocumentIds?: string[] | null;
  demoteDocumentIds?: string[] | null;
  excludeDocumentIds?: string[] | null;
  preferDocumentIds?: string[] | null;
  preferLatestVersion?: boolean | null;
  rerankBoost?: number | null;
  rerankPenalty?: number | null;
  answerInstruction?: string | null;
}

export type ProposalStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "superseded";

export type ProposalAuthor = "ai" | "human" | "system";

/** An AI-generated or manually created proposed correction, awaiting review. */
export interface CorrectionProposal {
  _id?: string; // = id
  id: string;
  tenantId: string;
  sourceFeedbackIds: string[];
  proposalType: PolicyType;
  status: ProposalStatus;
  proposedBy: ProposalAuthor;
  term?: string | null;
  canonicalMeaning?: string | null;
  description: string;
  rationale: string;
  confidenceScore?: number | null; // 0..1, AI confidence
  suggestedScope: PolicyScope;
  suggestedPolicy: {
    matchConditions: PolicyMatchConditions;
    actions: PolicyActions;
    priority?: number;
  };
  conflictPolicyIds?: string[] | null;
  impactSimulationId?: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
  /** Set once approved and converted to a policy. */
  approvedPolicyId?: string | null;
}

export type PolicyStatus = "active" | "inactive" | "superseded" | "archived";

/** An approved, governed correction policy applied deterministically at runtime. */
export interface KnowledgePolicy {
  _id?: string; // = id
  id: string;
  tenantId: string;
  policyType: PolicyType;
  status: PolicyStatus;
  version: number;
  name: string;
  description: string;
  scope: PolicyScope;
  matchConditions: PolicyMatchConditions;
  actions: PolicyActions;
  /** Higher wins on conflict. Specificity also factors into resolution. */
  priority: number;
  /** Policies in the same conflictGroup are mutually exclusive at runtime. */
  conflictGroup?: string | null;
  createdFromProposalId?: string | null;
  approvedBy: string;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
  deactivatedBy?: string | null;
  deactivatedAt?: string | null;
  deactivationReason?: string | null;
  /** When superseded by a newer version, points to the successor policy id. */
  supersededByPolicyId?: string | null;
}

/** Records how policies affected a single runtime query (explainability). */
export interface PolicyApplicationTrace {
  _id?: string; // = id
  id: string;
  tenantId: string;
  conversationId?: string | null;
  queryId: string;
  queryText: string;
  appliedPolicyIds: string[];
  skippedPolicyIds?: string[] | null;
  detectedTerms?: string[] | null;
  expandedQuery?: string | null;
  retrievalAdjustments: {
    boostedDocumentIds?: string[] | null;
    demotedDocumentIds?: string[] | null;
    excludedDocumentIds?: string[] | null;
    preferredDocumentIds?: string[] | null;
  };
  rankingAdjustments?: Record<string, unknown> | null;
  explanation: string;
  createdAt: string;
}

export type ConflictType =
  | "overlapping_scope"
  | "contradictory_term_mapping"
  | "boost_and_demote_same_source"
  | "version_preference_conflict"
  | "exclusion_conflict"
  | "duplicate_policy";

export type ConflictSeverity = "low" | "medium" | "high" | "blocking";
export type ConflictStatus = "open" | "resolved" | "ignored";

/** A detected conflict between proposals and/or approved policies. */
export interface PolicyConflict {
  _id?: string; // = id
  id: string;
  tenantId: string;
  conflictType: ConflictType;
  policyIds?: string[] | null;
  proposalIds?: string[] | null;
  description: string;
  severity: ConflictSeverity;
  status: ConflictStatus;
  resolutionNotes?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
}

/** Evaluation of a draft policy against sample/historical queries before approval. */
export interface PolicyImpactSimulation {
  _id?: string; // = id
  id: string;
  tenantId: string;
  proposalId?: string | null;
  policyDraft: {
    policyType: PolicyType;
    scope: PolicyScope;
    matchConditions: PolicyMatchConditions;
    actions: PolicyActions;
  };
  testQueryIds?: string[] | null;
  sampleQueries?: string[] | null;
  affectedQueryCount: number;
  improvedCount?: number | null;
  degradedCount?: number | null;
  neutralCount?: number | null;
  uncertainCount?: number | null;
  beforeAfterExamples: {
    query: string;
    before: string[]; // docIds (top-N) before
    after: string[]; // docIds (top-N) after
    verdict: "improved" | "degraded" | "neutral" | "uncertain";
  }[];
  summary: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Conversational memory: threads + individual messages.
//
// Each message is semantically embedded (into `embedding`, honouring the active
// embedding strategy exactly like chunks) and lexically indexed, so past turns
// can be recalled with semantic + keyword search across the whole memory store.
// ---------------------------------------------------------------------------

/** A conversation thread. */
export interface ConversationDoc {
  _id?: string;
  conversationId: string;
  title: string;
  /** True once a topic title was auto-generated (so we don't overwrite a
   *  human-renamed title). */
  autoTitled?: boolean;
  /** Optional owner/tenant scoping (single-tenant demo defaults). */
  userId?: string;
  tenantId?: string;
  messageCount: number;
  /** Preview of the last message for the sidebar. */
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
}

/** A single turn in a conversation. `messageText` is embedded + lexically indexed. */
export interface ConversationMessageDoc {
  /** `${conversationId}#${messageIndex}` — mirrors the chunk _id convention. */
  _id?: string;
  conversationId: string;
  messageIndex: number;
  role: "user" | "assistant";
  messageText: string;
  /** Semantic embedding of messageText (explicit-vector strategies only). */
  embedding?: number[];
  /** docIds the assistant grounded this answer on (assistant turns only). */
  sourceDocIds?: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Signature comparison: enrolled reference signatures, each with an IMAGE
// embedding (voyage-multimodal-3.5) for visual-similarity vector search.
// ---------------------------------------------------------------------------
export interface SignatureDoc {
  _id?: string;
  signatureId: string;
  /** Person the signature belongs to (the identity being verified). */
  signerName: string;
  /** Optional label, e.g. document/reference this specimen came from. */
  label?: string;
  /** Image embedding (voyage-multimodal-3.5, 1024d) — the match signal. */
  embedding?: number[];
  /** GridFS id of the original signature image (for preview). */
  originalFileId?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  /**
   * Normalized crop rectangle (0..1) of the signature region that was actually
   * embedded, so comparison is signature-to-signature rather than page-to-page.
   * Absent = whole image was used.
   */
  cropRect?: { x: number; y: number; w: number; h: number };
  createdAt: string;
}

export async function getSignaturesCollection(): Promise<
  Collection<SignatureDoc>
> {
  const db = await getDb();
  return db.collection<SignatureDoc>(env.signaturesCollection);
}

export async function getCollection(): Promise<Collection<ChunkDoc>> {
  const db = await getDb();
  return db.collection<ChunkDoc>(env.collectionName);
}

export async function getDocumentsCollection(): Promise<
  Collection<DocumentDoc>
> {
  const db = await getDb();
  return db.collection<DocumentDoc>(env.documentsCollection);
}

export async function getAliasesCollection(): Promise<
  Collection<PropertyAliasDoc>
> {
  const db = await getDb();
  return db.collection<PropertyAliasDoc>(env.aliasesCollection);
}

export async function getVersionsCollection(): Promise<
  Collection<DocumentVersionGroup>
> {
  const db = await getDb();
  return db.collection<DocumentVersionGroup>(env.versionsCollection);
}

export async function getCorrectionsCollection(): Promise<
  Collection<UserCorrection>
> {
  const db = await getDb();
  return db.collection<UserCorrection>(env.correctionsCollection);
}

export async function getIngestionJobsCollection(): Promise<
  Collection<IngestionJob>
> {
  const db = await getDb();
  return db.collection<IngestionJob>(env.ingestionJobsCollection);
}

// ----- Conversational memory collections -----

export async function getConversationsCollection(): Promise<
  Collection<ConversationDoc>
> {
  const db = await getDb();
  return db.collection<ConversationDoc>(env.conversationsCollection);
}

export async function getConversationMessagesCollection(): Promise<
  Collection<ConversationMessageDoc>
> {
  const db = await getDb();
  return db.collection<ConversationMessageDoc>(
    env.conversationMessagesCollection
  );
}

// ----- Knowledge Policy Layer collections -----

export async function getFeedbackCollection(): Promise<
  Collection<CorrectionFeedback>
> {
  const db = await getDb();
  return db.collection<CorrectionFeedback>(env.feedbackCollection);
}

export async function getProposalsCollection(): Promise<
  Collection<CorrectionProposal>
> {
  const db = await getDb();
  return db.collection<CorrectionProposal>(env.proposalsCollection);
}

export async function getPoliciesCollection(): Promise<
  Collection<KnowledgePolicy>
> {
  const db = await getDb();
  return db.collection<KnowledgePolicy>(env.policiesCollection);
}

export async function getPolicyTracesCollection(): Promise<
  Collection<PolicyApplicationTrace>
> {
  const db = await getDb();
  return db.collection<PolicyApplicationTrace>(env.policyTracesCollection);
}

export async function getPolicyConflictsCollection(): Promise<
  Collection<PolicyConflict>
> {
  const db = await getDb();
  return db.collection<PolicyConflict>(env.policyConflictsCollection);
}

export async function getPolicySimulationsCollection(): Promise<
  Collection<PolicyImpactSimulation>
> {
  const db = await getDb();
  return db.collection<PolicyImpactSimulation>(env.policySimulationsCollection);
}

/** GridFS bucket for storing original uploaded files (for content preview). */
export async function getFileBucket(): Promise<GridFSBucket> {
  const db = await getDb();
  return new GridFSBucket(db, { bucketName: env.fileBucketName });
}

/** Delete an original file from GridFS by its id string. Best-effort. */
export async function deleteOriginalFile(fileId?: string): Promise<void> {
  if (!fileId) return;
  try {
    const { ObjectId } = await import("mongodb");
    const bucket = await getFileBucket();
    await bucket.delete(new ObjectId(fileId));
  } catch {
    /* file may already be gone — ignore */
  }
}
