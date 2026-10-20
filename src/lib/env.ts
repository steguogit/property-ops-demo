// Centralised environment configuration. Reads from process.env so it works
// both in Next.js server runtime and in standalone tsx scripts.

// LLM config supports two shapes:
//  - Grove gateway (LLM_PROVIDER/LLM_API_KEY/LLM_MODEL/LLM_BASE_URL) using an
//    `api-key` header (Azure API Management style).
//  - Plain OpenAI-compatible (OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL)
//    using a Bearer header.
// LLM_* takes precedence when set.
const llmProvider = (process.env.LLM_PROVIDER ?? "").toLowerCase();
const llmApiKey = process.env.LLM_API_KEY ?? "";
const openaiApiKey = process.env.OPENAI_API_KEY ?? "";

export const env = {
  mongoUri: process.env.MONGODB_URI ?? "",
  dbName: process.env.MONGODB_DB ?? "property_ops_demo",
  collectionName: process.env.MONGODB_COLLECTION ?? "chunks",

  // Registry of demo datasets. Each dataset physically isolates a demo's
  // documents + chunks via the `datasetId` field so different demos never mix
  // in retrieval. Generalises the earlier property/fsi metadataType split.
  datasetsCollection: process.env.MONGODB_DATASETS_COLLECTION ?? "datasets",
  // The dataset a document/chunk belongs to when none is specified (legacy data
  // seeded before datasets existed is treated as this dataset).
  defaultDatasetId: process.env.DEFAULT_DATASET_ID ?? "property",

  // New collections for the document-lifecycle / ingestion iteration.
  documentsCollection: process.env.MONGODB_DOCUMENTS_COLLECTION ?? "documents",
  aliasesCollection: process.env.MONGODB_ALIASES_COLLECTION ?? "property_aliases",
  versionsCollection:
    process.env.MONGODB_VERSIONS_COLLECTION ?? "document_versions",
  correctionsCollection:
    process.env.MONGODB_CORRECTIONS_COLLECTION ?? "user_corrections",
  ingestionJobsCollection:
    process.env.MONGODB_INGESTION_JOBS_COLLECTION ?? "ingestion_jobs",

  // Token/usage audit trail for model API calls (LLM / embeddings / rerank),
  // powering the Dashboard's token-consumption metrics.
  usageEventsCollection:
    process.env.MONGODB_USAGE_EVENTS_COLLECTION ?? "usage_events",

  // ----- Conversational memory (chat history + semantic recall) -----
  // Two collections: conversation threads, and the individual messages. Each
  // message is semantically embedded so past turns can be recalled with
  // semantic + keyword search across the whole memory store.
  conversationsCollection:
    process.env.MONGODB_CONVERSATIONS_COLLECTION ?? "conversations",
  conversationMessagesCollection:
    process.env.MONGODB_CONVERSATION_MESSAGES_COLLECTION ??
    "conversation_messages",

  // ----- Signature comparison -----
  // Enrolled reference signatures: each stores an IMAGE embedding
  // (voyage-multimodal-3.5) so a query signature can be matched by visual
  // similarity via vector search.
  signaturesCollection:
    process.env.MONGODB_SIGNATURES_COLLECTION ?? "signatures",

  // ----- Knowledge Policy Layer (governed correction policies) -----
  // Human feedback -> AI proposal -> human-approved policy -> deterministic
  // runtime application -> trace. Each stage is its own collection so the
  // lifecycle is auditable and reversible.
  feedbackCollection:
    process.env.MONGODB_FEEDBACK_COLLECTION ?? "correction_feedback",
  proposalsCollection:
    process.env.MONGODB_PROPOSALS_COLLECTION ?? "correction_proposals",
  policiesCollection:
    process.env.MONGODB_POLICIES_COLLECTION ?? "knowledge_policies",
  policyTracesCollection:
    process.env.MONGODB_POLICY_TRACES_COLLECTION ?? "policy_application_traces",
  policyConflictsCollection:
    process.env.MONGODB_POLICY_CONFLICTS_COLLECTION ?? "policy_conflicts",
  policySimulationsCollection:
    process.env.MONGODB_POLICY_SIMULATIONS_COLLECTION ??
    "policy_impact_simulations",

  // Default tenant used when no multi-tenant context is supplied (demo runs
  // single-tenant). All policy queries are still tenant-scoped.
  defaultTenantId: process.env.DEFAULT_TENANT_ID ?? "default",

  // Governance switch: when false (default) AI-generated proposals are NEVER
  // auto-activated — a human must approve. Set to true only for lab demos.
  autoApproveAiProposals:
    (process.env.AUTO_APPROVE_AI_PROPOSALS ?? "false").toLowerCase() === "true",
  // GridFS bucket holding original uploaded files (for content preview).
  fileBucketName: process.env.MONGODB_FILE_BUCKET ?? "original_files",

  vectorIndex: process.env.ATLAS_VECTOR_INDEX ?? "vector_index",
  searchIndex: process.env.ATLAS_SEARCH_INDEX ?? "lexical_index",
  // Secondary vector index for the voyage-multimodal-3.5 comparison model.
  // This is an explicit-vector index over the `embeddingMultimodal` field
  // (populated client-side), independent of the primary Atlas auto-embed index.
  vectorIndexMultimodal:
    process.env.ATLAS_VECTOR_INDEX_MM ?? "vector_index_mm",

  // Indexes for the conversation-memory collection (distinct from the corpus
  // chunk indexes). Vector index embeds `messageText`; lexical index enables
  // keyword recall over past turns.
  convVectorIndex:
    process.env.ATLAS_CONV_VECTOR_INDEX ?? "conv_vector_index",
  convSearchIndex:
    process.env.ATLAS_CONV_SEARCH_INDEX ?? "conv_lexical_index",

  // Signature image-embedding vector index (voyage-multimodal-3.5, 1024d).
  signatureVectorIndex:
    process.env.ATLAS_SIGNATURE_VECTOR_INDEX ?? "signature_vector_index",
  // Match-confidence thresholds on the Atlas vectorSearchScore, which for cosine
  // is (1 + cosine) / 2. Calibrated for signature-REGION crops: genuine matches
  // sit very high (~0.95+), while different signatures land well below even when
  // the surrounding page is identical (e.g. raw cos 0.79 -> ~0.90). We set the
  // bands tighter than generic image similarity to reflect that separation.
  signatureMatchThreshold: parseFloat(
    process.env.SIGNATURE_MATCH_THRESHOLD ?? "0.93"
  ),
  signatureReviewThreshold: parseFloat(
    process.env.SIGNATURE_REVIEW_THRESHOLD ?? "0.88"
  ),

  // OCR / extraction tuning.
  ocrLangs: process.env.OCR_LANGS ?? "eng+chi_tra+chi_sim",
  // When local text extraction yields fewer than this many characters, the
  // ingestion pipeline treats the file as image-heavy / scanned and triggers
  // OCR (and, if available, an LLM vision pass).
  ocrMinChars: parseInt(process.env.OCR_MIN_CHARS ?? "40", 10),
  // Max pages to rasterise + OCR for a scanned/image-only PDF (bounds latency).
  pdfOcrMaxPages: parseInt(process.env.PDF_OCR_MAX_PAGES ?? "50", 10),
  // OCR engine for scanned pages: "tesseract" (local, free, default) or
  // "vision" (LLM vision — more accurate but costly/slow at scale).
  // OCR engine for scanned pages:
  //   "tesseract" — local, free, no models to bundle (default; weaker CJK).
  //   "onnx"      — local PaddleOCR PP-OCRv4 via ONNX (best CJK accuracy).
  //   "vision"    — LLM vision (most accurate, but costly/slow at scale).
  ocrEngine: (process.env.OCR_ENGINE ?? "tesseract") as
    | "tesseract"
    | "onnx"
    | "vision",
  // Optional override for the PaddleOCR ONNX models directory (contains
  // ch_PP-OCRv4_det_infer.onnx, ch_PP-OCRv4_rec_infer.onnx, ppocr_keys_v1.txt).
  onnxOcrModelsDir: process.env.ONNX_OCR_MODELS_DIR ?? "",
  // ----- External PaddleOCR HTTP microservice (backend-separated OCR) -----
  // When enabled, image OCR is delegated to the standalone Python FastAPI
  // PaddleOCR service (./ocr-service). It returns layout blocks with direction,
  // which the Node side reorders (right-to-left / top-to-bottom for vertical
  // Chinese) so mixed horizontal+vertical handwriting keeps the correct reading
  // order for embeddings. If the service is unreachable, ingestion falls back to
  // the existing local OCR (Tesseract / ONNX / vision) automatically.
  useExternalPaddleOcr:
    (process.env.USE_EXTERNAL_PADDLE_OCR ?? "false").toLowerCase() === "true",
  // Full URL to the OCR service's /ocr endpoint. The port is NOT hard-coded
  // (8000 is used by another local demo). Local dev default targets 127.0.0.1;
  // in Docker set this to http://host.docker.internal:<port>/ocr.
  ocrServiceUrl: process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8001/ocr",
  // Timeout (ms) for a single OCR HTTP call before falling back to local OCR.
  ocrServiceTimeoutMs: parseInt(
    process.env.OCR_SERVICE_TIMEOUT_MS ?? "60000",
    10
  ),
  // Whether scanned/image-only PDFs are OCR'd (local) on upload so their text is
  // keyword-searchable. Default true. Set false to defer OCR (image-embed only).
  pdfOcrOnUpload:
    (process.env.PDF_OCR_ON_UPLOAD ?? "true").toLowerCase() !== "false",

  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  voyageEmbedModel: process.env.VOYAGE_EMBED_MODEL ?? "voyage-3",
  voyageEmbedDim: parseInt(process.env.VOYAGE_EMBED_DIM ?? "1024", 10),
  voyageRerankModel: process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5",

  // ----- Reranker (Voyage AI by MongoDB / Atlas Model API) -----
  // The "Vector + Reranker" path calls a Voyage-compatible rerank endpoint.
  // By default we route through MongoDB's Atlas-hosted gateway
  // (https://ai.mongodb.com/v1) authenticated with an Atlas *Model API key*
  // (ATLAS_MODEL_API_KEY, starts with "al-"). This has proper usage-tier rate
  // limits, unlike a personal Voyage free-tier key (3 RPM / 10K TPM -> 429).
  // Falls back to VOYAGE_API_KEY so existing setups keep working.
  rerankBaseUrl: process.env.RERANK_BASE_URL ?? "https://ai.mongodb.com/v1",
  rerankApiKey: process.env.ATLAS_MODEL_API_KEY ?? process.env.VOYAGE_API_KEY ?? "",

  // Atlas automatic-embedding model (voyage-4 family) used when
  // EMBEDDING_STRATEGY=atlas. Atlas embeds both stored docs and query strings.
  atlasAutoEmbedModel: process.env.ATLAS_AUTOEMBED_MODEL ?? "voyage-4",

  // ----- Secondary (multimodal) embedding model for A/B comparison -----
  // voyage-multimodal-3.5 vectors are generated client-side via the Atlas
  // Model API gateway and stored in the `embeddingMultimodal` field, so we can
  // compare its vector-search ranking against the primary voyage-4 auto-embed.
  // Uses the same base URL + key as the reranker (Voyage AI by MongoDB).
  multimodalEmbedEnabled:
    (process.env.MULTIMODAL_EMBED_ENABLED ?? "true").toLowerCase() !== "false",
  multimodalEmbedModel:
    process.env.MULTIMODAL_EMBED_MODEL ?? "voyage-multimodal-3.5",
  multimodalEmbedDim: parseInt(process.env.MULTIMODAL_EMBED_DIM ?? "1024", 10),

  // ----- LLM (unified) -----
  llmProvider: llmApiKey ? (llmProvider || "openai") : openaiApiKey ? "openai" : "",
  llmApiKey: llmApiKey || openaiApiKey,
  llmBaseUrl:
    process.env.LLM_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1",
  llmModel: process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  // Grove gateway authenticates with an `api-key` header; OpenAI uses Bearer.
  llmAuthHeader: (process.env.LLM_PROVIDER ? "api-key" : "bearer") as
    | "api-key"
    | "bearer",

  embeddingStrategy: (process.env.EMBEDDING_STRATEGY ?? "voyage") as
    | "voyage"
    | "atlas",
};

export function assertMongo() {
  if (!env.mongoUri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env and fill in your Atlas connection string."
    );
  }
}

export function hasVoyage() {
  return Boolean(env.voyageApiKey);
}

/** Whether the external PaddleOCR HTTP microservice is enabled + configured. */
export function hasExternalPaddleOcr() {
  return env.useExternalPaddleOcr && Boolean(env.ocrServiceUrl);
}

export function hasReranker() {
  return Boolean(env.rerankApiKey);
}

export function hasLLM() {
  return Boolean(env.llmApiKey);
}

export function isAtlasEmbedding() {
  return env.embeddingStrategy === "atlas";
}

/**
 * Whether the secondary voyage-multimodal-3.5 embedding is enabled. Requires a
 * reranker/model API key (same Atlas Model API gateway) and the feature flag.
 */
export function hasMultimodalEmbed() {
  return env.multimodalEmbedEnabled && Boolean(env.rerankApiKey);
}

/**
 * Whether the configured LLM is expected to accept image (vision) inputs, used
 * for the LLM-assisted OCR / caption fallback on image-heavy uploads. Defaults
 * to true when an LLM is configured; set LLM_VISION=false to disable.
 */
export function hasVisionLLM() {
  if (!env.llmApiKey) return false;
  return (process.env.LLM_VISION ?? "true").toLowerCase() !== "false";
}
