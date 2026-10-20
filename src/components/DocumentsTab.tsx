"use client";

import React, { useEffect, useRef, useState } from "react";
import { CodeBlock } from "./Modal";
import { FilePreviewDialog } from "./FilePreview";
import { useI18n } from "@/lib/i18n";
import { useDataset } from "@/lib/dataset-context";

interface DocumentDoc {
  documentId: string;
  title: string;
  docType: string;
  propertyName: string;
  propertyAliases: string[];
  sourceFileName: string;
  sourceFileType: string;
  mimeType?: string;
  originalFileId?: string;
  fileSizeBytes?: number;
  ocrUsed: boolean;
  extractionMethod?: string;
  extractionNote?: string;
  extractedTextPreview?: string;
  chunkCount: number;
  embeddingStatus: string;
  versionLabel?: string;
  obsoleteFlag: boolean;
  effectiveFrom?: string;
  reviewStatus: string;
  status: string;
  signatureStatus?:
    | "pending"
    | "signed"
    | "unsigned"
    | "not_required"
    | "unknown";
  signatureNote?: string;
  uploadedAt: string;
}

interface IngestStep {
  step: string;
  status: string;
  ms?: number;
  note?: string;
}

/** A persisted ingestion job (processing trace) returned by the history API. */
interface IngestionJobView {
  jobId: string;
  documentId: string;
  sourceFileName: string;
  status: string;
  steps: IngestStep[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  docTitle?: string;
  sourceFileType?: string;
  chunkCount?: number;
  ocrUsed?: boolean;
}

/** One item in the bulk-upload queue, tracked live in the UI. */
interface QueueItem {
  id: string;
  file: File;
  status: "queued" | "uploading" | "done" | "error";
  /** Wall-clock the client measured for the whole request (upload + ingest). */
  totalMs?: number;
  /** Server-reported timed steps (the real behind-the-scenes trace). */
  steps?: IngestStep[];
  chunkCount?: number;
  ocrUsed?: boolean;
  docStatus?: string;
  documentId?: string;
  error?: string;
}

// Human labels for the server's step keys, in the order the server runs them.
// Some steps are genuinely near-instant — the `why` text explains why, so a
// real "<1ms" reading next to "Generate embeddings" isn't confusing.
const STEP_LABELS: Record<string, { label: string; why?: string }> = {
  extract: {
    label: "Extract text / OCR",
    why: "Reads the file; runs OCR for scanned/image content (usually the slowest step).",
  },
  enrich_aliases: {
    label: "Resolve property aliases",
    why: "In-memory lookup against the alias master — typically sub-millisecond.",
  },
  chunk: {
    label: "Chunk (sentence-aware)",
    why: "In-memory sentence splitting — no I/O, typically sub-millisecond.",
  },
  store_original: { label: "Store original (GridFS)" },
  embed: {
    label: "Generate embeddings",
    why: "With Atlas auto-embedding, vectors are created by Atlas on write — no client-side call here, so this reads ~0ms. With explicit Voyage embeddings it reflects the API call time.",
  },
  embed_multimodal: { label: "Embed (voyage-multimodal-3.5)" },
  embed_page_images: { label: "Embed scanned page images" },
  embed_image_pixels: { label: "Embed image pixels" },
  write: { label: "Write documents + chunks (Atlas)" },
};

function stepLabel(key: string): string {
  return STEP_LABELS[key]?.label ?? key;
}

const DOC_TYPES = [
  "om_manual",
  "sop",
  "incident_report",
  "floor_plan",
  "technician_guide",
  "utility_export",
  "faq",
  "contractor_procedure",
  "duty_roster",
  "property_alias_master",
  "uploaded_document",
];

export function DocumentsTab() {
  const { t } = useI18n();
  const {
    activeId: datasetId,
    active: activeDataset,
    refresh: refreshDatasets,
  } = useDataset();
  const [docs, setDocs] = useState<DocumentDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<DocumentDoc | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentDoc | null>(null);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(
    null
  );
  const [drag, setDrag] = useState(false);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Bulk upload: many files can be selected/dropped at once. `files` is the
  // staged selection; `queue` is the live processing view during ingestion.
  const [files, setFiles] = useState<File[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // Persisted processing history (survives refresh), scoped to the dataset.
  const [history, setHistory] = useState<IngestionJobView[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);

  // upload form metadata (applied to every file in a bulk upload)
  const [meta, setMeta] = useState({
    title: "",
    docType: "om_manual",
    propertyName: "",
    versionLabel: "",
    versionGroupId: "",
    effectiveFrom: "",
    tags: "",
    exactTerms: "",
  });

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(
        `/api/documents?datasetId=${encodeURIComponent(datasetId)}`
      );
      const data = await res.json();
      setDocs(data.documents ?? []);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch(
        `/api/ingestion-jobs?datasetId=${encodeURIComponent(datasetId)}`
      );
      const data = await res.json();
      setHistory(data.jobs ?? []);
    } catch {
      /* best-effort */
    }
  }

  // Reload whenever the active dataset changes (isolation: only its docs show).
  useEffect(() => {
    load();
    loadHistory();
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // Poll while any document's signature analysis is still pending (it runs
  // asynchronously after upload), so the badge updates without a manual refresh.
  useEffect(() => {
    const anyPending = docs.some((d) => d.signatureStatus === "pending");
    if (!anyPending) return;
    const id = setInterval(() => load(true), 4000);
    return () => clearInterval(id);
  }, [docs]);

  // Add one or many files to the staged selection (dedupe by name+size).
  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => {
      const key = (f: File) => `${f.name}:${f.size}`;
      const seen = new Set(prev.map(key));
      const merged = [...prev];
      for (const f of incoming) if (!seen.has(key(f))) merged.push(f);
      return merged;
    });
    // Default the title from the first file only when a single file is staged.
    if (incoming.length === 1 && files.length === 0 && !meta.title) {
      setMeta((m) => ({
        ...m,
        title: incoming[0].name.replace(/\.[^.]+$/, ""),
      }));
    }
  }

  function removeStaged(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  // Bulk upload: process the staged files sequentially (safer for OCR / Voyage
  // rate limits). Each file goes to the active dataset. Timings shown come from
  // the SERVER's real per-step measurements (no faked client-side animation).
  async function upload() {
    if (!files.length) {
      setNotice({ kind: "warn", text: t("docs.chooseFirst") });
      return;
    }
    setUploading(true);
    setNotice(null);

    const items: QueueItem[] = files.map((file, i) => ({
      id: `${Date.now()}-${i}-${file.name}`,
      file,
      status: "queued",
    }));
    setQueue(items);
    const staged = files;
    setFiles([]);

    let ok = 0;
    let failed = 0;
    for (const item of items) {
      // Mark as processing (honest single "in flight" state — no fake stage
      // stepping). Real per-stage durations arrive with the server response.
      setQueue((q) =>
        q.map((it) => (it.id === item.id ? { ...it, status: "uploading" } : it))
      );
      const t0 = Date.now();
      try {
        const fd = new FormData();
        fd.append("file", item.file);
        fd.append("datasetId", datasetId);
        // Only send a per-file title when a single file is uploaded; for bulk
        // the server derives each title from its file name.
        Object.entries(meta).forEach(([k, v]) => {
          if (!v) return;
          if (k === "title" && staged.length > 1) return;
          fd.append(k, v);
        });
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        const totalMs = Date.now() - t0;
        if (data.error) {
          failed++;
          setQueue((q) =>
            q.map((it) =>
              it.id === item.id
                ? { ...it, status: "error", error: data.error, totalMs }
                : it
            )
          );
        } else {
          ok++;
          setQueue((q) =>
            q.map((it) =>
              it.id === item.id
                ? {
                    ...it,
                    status: "done",
                    totalMs,
                    steps: data.job?.steps ?? [],
                    chunkCount: data.chunkCount,
                    ocrUsed: data.document?.ocrUsed,
                    docStatus: data.document?.status,
                    documentId: data.document?.documentId,
                  }
                : it
            )
          );
        }
      } catch (e) {
        failed++;
        setQueue((q) =>
          q.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: "error",
                  error: (e as Error).message,
                  totalMs: Date.now() - t0,
                }
              : it
          )
        );
      }
      await load(true);
    }

    setNotice({
      kind: failed ? "warn" : "info",
      text: `Ingested ${ok} file(s)${
        failed ? `, ${failed} failed` : ""
      } into "${activeDataset?.name ?? datasetId}".`,
    });
    setUploading(false);
    await refreshDatasets();
    await loadHistory();
  }

  async function patch(documentId: string, body: any) {
    await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
    if (selected?.documentId === documentId) {
      const res = await fetch(`/api/documents/${documentId}`);
      const data = await res.json();
      setSelected(data.document);
    }
  }

  async function reindex(documentId: string, title?: string) {
    const label = title ? `"${title}"` : documentId;
    if (!window.confirm(t("docs.reindexConfirm", { label }))) return;
    setReindexingId(documentId);
    setNotice(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/reindex`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setNotice({
          kind: "warn",
          text: data.error || t("docs.reindexFailed"),
        });
        return;
      }
      setNotice({
        kind: "info",
        text: t("docs.reindexed", {
          label,
          method: data.document?.extractionMethod ?? "",
          chunks: data.chunkCount ?? 0,
        }),
      });
      await load();
      await loadHistory();
      if (selected?.documentId === documentId) {
        const r = await fetch(`/api/documents/${documentId}`);
        setSelected((await r.json()).document);
      }
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    } finally {
      setReindexingId(null);
    }
  }

  async function remove(documentId: string, title?: string) {
    const label = title ? `"${title}"` : documentId;
    if (!window.confirm(t("docs.deleteConfirm", { label }))) {
      return;
    }
    try {
      const res = await fetch(`/api/documents/${documentId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setNotice({
          kind: "warn",
          text: data.error || t("docs.deleteFailed", { status: res.status }),
        });
        return;
      }
      if (selected?.documentId === documentId) setSelected(null);
      if (previewDoc?.documentId === documentId) setPreviewDoc(null);
      setNotice({ kind: "info", text: t("docs.deleted", { label }) });
      await load();
      await refreshDatasets();
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>{t("docs.uploadTitle")}</h2>
        <p className="sub">{t("docs.uploadSub")}</p>

        {/* Which demo the uploads will land in — isolation is explicit. */}
        <div
          className="notice info"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span>
            Uploading to demo:&nbsp;
            <b>{activeDataset?.name ?? datasetId}</b>
            {activeDataset?.documentCount != null && (
              <> · {activeDataset.documentCount} doc(s)</>
            )}
          </span>
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
            Switch demos from the dataset dropdown in the header.
          </span>
        </div>

        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        <div className="upload-grid">
          <div
            className={`dropzone ${drag ? "drag" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept=".pdf,.docx,.xlsx,.xls,.csv,.pptx,.png,.jpg,.jpeg,.webp,.tif,.tiff,.txt,.md"
              onChange={(e) => addFiles(e.target.files)}
            />
            {files.length ? (
              <div style={{ width: "100%" }}>
                <b>
                  {files.length} file{files.length > 1 ? "s" : ""} staged
                </b>
                <div className="types">Click or drop to add more</div>
                <ul className="staged-list">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      <span className="staged-name">{f.name}</span>
                      <span className="staged-size">
                        {(f.size / 1024).toFixed(0)} KB
                      </span>
                      <button
                        className="mini-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeStaged(i);
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div>
                <b>{t("docs.dropPrompt")}</b> {t("docs.dropToIngest")} — you can
                select or drop <b>many files</b> for bulk import.
                <div className="types">{t("docs.dropTypes")}</div>
              </div>
            )}
          </div>

          <div className="form-grid">
            <div className="field full">
              <label>
                {t("docs.title")}
                {files.length > 1 && (
                  <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
                    {" "}
                    — ignored for bulk (title taken from each file name)
                  </span>
                )}
              </label>
              <input
                value={meta.title}
                onChange={(e) => setMeta({ ...meta, title: e.target.value })}
                placeholder={t("docs.titlePlaceholder")}
                disabled={files.length > 1}
              />
            </div>
            <div className="field">
              <label>{t("docs.docType")}</label>
              <select
                value={meta.docType}
                onChange={(e) => setMeta({ ...meta, docType: e.target.value })}
              >
                {DOC_TYPES.map((dt) => (
                  <option key={dt} value={dt}>
                    {dt}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("docs.propertyName")}</label>
              <input
                value={meta.propertyName}
                onChange={(e) =>
                  setMeta({ ...meta, propertyName: e.target.value })
                }
                placeholder="ICC / 環球貿易廣場"
              />
            </div>
            <div className="field">
              <label>{t("docs.versionLabel")}</label>
              <input
                value={meta.versionLabel}
                onChange={(e) =>
                  setMeta({ ...meta, versionLabel: e.target.value })
                }
                placeholder="v2023.1"
              />
            </div>
            <div className="field">
              <label>{t("docs.effectiveFrom")}</label>
              <input
                type="date"
                value={meta.effectiveFrom}
                onChange={(e) =>
                  setMeta({ ...meta, effectiveFrom: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label>{t("docs.versionGroupId")}</label>
              <input
                value={meta.versionGroupId}
                onChange={(e) =>
                  setMeta({ ...meta, versionGroupId: e.target.value })
                }
                placeholder="VG-ICC-CHILLER-OM"
              />
            </div>
            <div className="field">
              <label>{t("docs.tags")}</label>
              <input
                value={meta.tags}
                onChange={(e) => setMeta({ ...meta, tags: e.target.value })}
                placeholder="hvac, chiller, om"
              />
            </div>
            <div className="field full">
              <label>{t("docs.exactTerms")}</label>
              <input
                value={meta.exactTerms}
                onChange={(e) =>
                  setMeta({ ...meta, exactTerms: e.target.value })
                }
                placeholder="chiller plant, 冷水機房, ICC"
              />
            </div>
            <div className="field full">
              <button
                className="btn primary"
                onClick={upload}
                disabled={uploading || !files.length}
              >
                {uploading ? (
                  <>
                    <span className="loading" /> {t("docs.uploading")}
                  </>
                ) : files.length > 1 ? (
                  `Ingest ${files.length} files`
                ) : (
                  t("docs.uploadBtn")
                )}
              </button>
            </div>
          </div>
        </div>

        {!!queue.length && (
          <div style={{ marginTop: 16 }}>
            <div className="stage-label">
              Behind the scenes — ingestion pipeline (
              {queue.filter((q) => q.status === "done").length}/{queue.length}{" "}
              done)
            </div>
            <div className="ingest-queue">
              {queue.map((it) => (
                <ProcessingCard key={it.id} item={it} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Persisted processing history — collapsible, survives refresh. Each
          document's ingestion trace can be folded up/down independently. */}
      <div className="panel">
        <div
          className="history-panel-head"
          onClick={() => setHistoryOpen((v) => !v)}
          role="button"
          tabIndex={0}
        >
          <div>
            <h2 style={{ margin: 0 }}>
              {t("docs.historyTitle")}{" "}
              <span className="history-count">{history.length}</span>
            </h2>
            <p className="sub" style={{ margin: "2px 0 0" }}>
              {t("docs.historySub")}
            </p>
          </div>
          <span className="history-caret">{historyOpen ? "▾" : "▸"}</span>
        </div>
        {historyOpen && (
          <div style={{ marginTop: 12 }}>
            {!history.length && (
              <div className="empty">{t("docs.historyEmpty")}</div>
            )}
            <div className="history-list">
              {history.map((j) => (
                <HistoryCard key={j.jobId} job={j} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>{t("docs.libraryTitle", { n: docs.length })}</h2>
        <p className="sub">{t("docs.librarySub")}</p>
        {loading && <div className="empty">{t("common.loading")}</div>}
        {!loading && !docs.length && (
          <div className="empty">{t("docs.emptyLibrary")}</div>
        )}
        {!!docs.length && (
          <table className="doc-table">
            <thead>
              <tr>
                <th>{t("docs.col.title")}</th>
                <th>{t("docs.col.type")}</th>
                <th>{t("docs.col.property")}</th>
                <th>{t("docs.col.file")}</th>
                <th>{t("docs.col.chunks")}</th>
                <th>{t("docs.col.version")}</th>
                <th>{t("docs.col.signature")}</th>
                <th>{t("docs.col.status")}</th>
                <th>{t("docs.col.review")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.documentId}>
                  <td>
                    <b>{d.title}</b>
                    <div style={{ color: "var(--text-faint)", fontSize: 11 }}>
                      {d.documentId}
                    </div>
                  </td>
                  <td>{d.docType}</td>
                  <td>{d.propertyName}</td>
                  <td>
                    {d.sourceFileType}
                    {d.ocrUsed && (
                      <span className="badge ocr" style={{ marginLeft: 4 }}>
                        OCR
                      </span>
                    )}
                  </td>
                  <td>{d.chunkCount}</td>
                  <td>
                    {d.versionLabel ?? "—"}
                    {d.obsoleteFlag && (
                      <span className="badge obsolete" style={{ marginLeft: 4 }}>
                        obs
                      </span>
                    )}
                  </td>
                  <td>
                    {d.signatureStatus ? (
                      <span
                        className={`sig-tag ${d.signatureStatus}`}
                        title={d.signatureNote}
                      >
                        {t(`docs.sig.${d.signatureStatus}`)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span className={`status-tag ${d.status}`}>{d.status}</span>
                  </td>
                  <td>
                    <span className={`status-tag ${d.reviewStatus}`}>
                      {d.reviewStatus}
                    </span>
                  </td>
                  <td>
                    <div className="doc-row-actions">
                      <button
                        className="mini-btn"
                        onClick={() => setSelected(d)}
                      >
                        {t("docs.review")}
                      </button>
                      {d.originalFileId && (
                        <button
                          className="btn sm preview-btn"
                          onClick={() => setPreviewDoc(d)}
                          title={t("docs.preview")}
                        >
                          {t("docs.preview")}
                        </button>
                      )}
                      {d.originalFileId && (
                        <button
                          className="btn sm"
                          onClick={() => reindex(d.documentId, d.title)}
                          disabled={reindexingId === d.documentId}
                          title={t("docs.reindexTitle")}
                        >
                          {reindexingId === d.documentId ? (
                            <>
                              <span className="loading" /> {t("docs.reindexing")}
                            </>
                          ) : (
                            t("docs.reindex")
                          )}
                        </button>
                      )}
                      <button
                        className="btn sm danger"
                        onClick={() => remove(d.documentId, d.title)}
                        title={t("docs.deleteTitle")}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="panel">
          <h2>{t("docs.reviewTitle", { title: selected.title })}</h2>
          <p className="sub">{selected.documentId}</p>
          <div className="review-detail">
            <div className="kv">
              <span className="k">{t("docs.col.file")}</span>
              <span>
                {selected.sourceFileName} ({selected.sourceFileType})
              </span>
              <span className="k">Extraction</span>
              <span>
                {selected.extractionMethod}
                {selected.ocrUsed
                  ? ` · ${t("docs.ocrUsed")}`
                  : ` · ${t("docs.noOcr")}`}
              </span>
              {selected.extractionNote && (
                <>
                  <span className="k">Caveat</span>
                  <span style={{ color: "var(--amber)" }}>
                    {selected.extractionNote}
                  </span>
                </>
              )}
              <span className="k">Chunks</span>
              <span>{selected.chunkCount}</span>
              {selected.signatureStatus && (
                <>
                  <span className="k">{t("docs.col.signature")}</span>
                  <span>
                    <span className={`sig-tag ${selected.signatureStatus}`}>
                      {t(`docs.sig.${selected.signatureStatus}`)}
                    </span>
                    {selected.signatureNote ? ` — ${selected.signatureNote}` : ""}
                  </span>
                </>
              )}
              <span className="k">Embedding</span>
              <span>{selected.embeddingStatus}</span>
              <span className="k">Property</span>
              <span>{selected.propertyName}</span>
              <span className="k">Aliases</span>
              <span>
                {selected.propertyAliases?.join(", ") || "—"}
              </span>
              <span className="k">Version</span>
              <span>
                {selected.versionLabel ?? "—"}
                {selected.obsoleteFlag ? " (obsolete)" : ""}
                {selected.effectiveFrom
                  ? ` · effective ${selected.effectiveFrom}`
                  : ""}
              </span>
              <span className="k">Status</span>
              <span>
                <span className={`status-tag ${selected.status}`}>
                  {selected.status}
                </span>{" "}
                <span className={`status-tag ${selected.reviewStatus}`}>
                  {selected.reviewStatus}
                </span>
              </span>
            </div>

            <div>
              <div className="stage-label">{t("docs.extractedPreview")}</div>
              <div className="preview-box">
                {selected.extractedTextPreview || t("docs.noText")}
              </div>
            </div>

            <div>
              <div className="stage-label">{t("docs.actualContent")}</div>
              {selected.originalFileId ? (
                <div className="doc-row-actions">
                  <button
                    className="btn primary preview-btn-lg"
                    onClick={() => setPreviewDoc(selected)}
                  >
                    {t("docs.previewFullscreen")}
                  </button>
                  <a
                    className="btn sm"
                    href={`/api/documents/${selected.documentId}/file?download=1`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    {t("docs.downloadOriginal")}
                  </a>
                </div>
              ) : (
                <span style={{ color: "var(--text-faint)" }}>
                  {t("docs.noOriginal")}
                </span>
              )}
            </div>

            <div className="doc-row-actions">
              <button
                className="btn sm"
                onClick={() =>
                  patch(selected.documentId, { reviewStatus: "approved" })
                }
              >
                {t("docs.approve")}
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  patch(selected.documentId, {
                    reviewStatus: "needs_correction",
                  })
                }
              >
                {t("docs.needsCorrection")}
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  patch(selected.documentId, {
                    obsoleteFlag: !selected.obsoleteFlag,
                  })
                }
              >
                {selected.obsoleteFlag
                  ? t("docs.unmarkObsolete")
                  : t("docs.markObsolete")}
              </button>
              <button
                className="btn sm danger"
                onClick={() => remove(selected.documentId, selected.title)}
              >
                {t("common.delete")}
              </button>
              <button
                className="btn sm"
                style={{ marginLeft: "auto" }}
                onClick={() => setSelected(null)}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      <FilePreviewDialog
        open={!!previewDoc}
        target={
          previewDoc
            ? {
                documentId: previewDoc.documentId,
                sourceFileName: previewDoc.sourceFileName,
                sourceFileType: previewDoc.sourceFileType,
                title: previewDoc.title,
              }
            : null
        }
        onClose={() => setPreviewDoc(null)}
      />
    </div>
  );
}

/** Format a measured duration honestly (0ms real steps become "<1 ms"). */
function fmtMs(ms?: number): string {
  if (ms == null) return "—";
  if (ms === 0) return "<1 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/**
 * Live per-file processing card for the bulk-upload queue. While the request is
 * in flight it shows a single honest "processing" state; once the server
 * responds it renders the REAL measured steps in execution order, each with a
 * proportional duration bar. No client-side faked timings — the numbers are the
 * server's own per-step measurements from the ingestion job.
 */
function ProcessingCard({ item }: { item: QueueItem }) {
  const [showTrace, setShowTrace] = useState(false);

  const steps = item.steps ?? [];
  // Scale bars against the slowest real step so the visual matches the numbers.
  const maxMs = Math.max(1, ...steps.map((s) => s.ms ?? 0));
  const sumMs = steps.reduce((a, s) => a + (s.ms ?? 0), 0);

  return (
    <div className={`ingest-card ${item.status}`}>
      <div className="ingest-card-head">
        <span className="ingest-file" title={item.file.name}>
          {item.file.name}
        </span>
        <span className={`status-tag ${item.status}`}>
          {item.status === "uploading"
            ? "processing…"
            : item.status === "done"
            ? item.docStatus ?? "done"
            : item.status}
        </span>
      </div>

      {/* While in flight: a single honest indeterminate bar (we don't yet know
          the real per-step timings — those arrive with the response). */}
      {item.status === "uploading" && (
        <div className="ingest-progress">
          <span className="loading" /> Extracting, chunking &amp; embedding on
          the server…
        </div>
      )}

      {/* Once complete: the REAL steps in server order, with proportional bars
          and true durations. Skipped/instant steps are labelled clearly. */}
      {steps.length > 0 && (
        <div className="step-list">
          {steps.map((s, i) => {
            const meta = STEP_LABELS[s.step];
            const pct = Math.round(((s.ms ?? 0) / maxMs) * 100);
            const skipped =
              s.status === "skipped" || s.status === "low_confidence";
            return (
              <div className="step-row" key={`${s.step}-${i}`}>
                <div className="step-row-head">
                  <span className="step-name" title={meta?.why}>
                    {stepLabel(s.step)}
                    {meta?.why && <span className="step-why-icon"> ⓘ</span>}
                  </span>
                  <span className="step-ms">{fmtMs(s.ms)}</span>
                </div>
                <div className="step-bar-track">
                  <div
                    className={`step-bar-fill ${skipped ? "skipped" : ""}`}
                    style={{ width: `${Math.max(pct, s.ms ? 3 : 0)}%` }}
                  />
                </div>
                {(s.note || skipped) && (
                  <div className="step-note">
                    {skipped ? "skipped — " : ""}
                    {s.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {item.status === "done" && (
        <div className="ingest-summary">
          <span>{item.chunkCount ?? 0} chunk(s)</span>
          {item.ocrUsed && <span className="badge ocr">OCR</span>}
          <span title="Sum of the server's measured per-step durations">
            server work: {fmtMs(sumMs)}
          </span>
          {item.totalMs != null && (
            <span title="End-to-end, including network upload + response">
              total: {fmtMs(item.totalMs)}
            </span>
          )}
          <button className="mini-btn" onClick={() => setShowTrace((v) => !v)}>
            {showTrace ? "Hide raw trace" : "Show raw trace"}
          </button>
        </div>
      )}
      {item.status === "error" && (
        <div className="ingest-summary" style={{ color: "var(--red, #d33)" }}>
          {item.error}
        </div>
      )}
      {showTrace && item.steps && (
        <div style={{ marginTop: 8 }}>
          <CodeBlock value={item.steps} />
        </div>
      )}
    </div>
  );
}

/**
 * One persisted ingestion trace in the collapsible Processing History. Folded up
 * by default; expanding reveals the real per-step durations (same visual as the
 * live upload view) plus an optional raw trace. Reads entirely from the stored
 * `ingestion_jobs` record, so it is available long after the upload finished.
 */
function HistoryCard({ job }: { job: IngestionJobView }) {
  const [open, setOpen] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const steps = job.steps ?? [];
  const maxMs = Math.max(1, ...steps.map((s) => s.ms ?? 0));
  const sumMs = steps.reduce((a, s) => a + (s.ms ?? 0), 0);
  const when = new Date(job.createdAt);

  return (
    <div className={`history-card ${job.status}`}>
      <div
        className="history-card-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
      >
        <span className="history-caret sm">{open ? "▾" : "▸"}</span>
        <span className="history-file" title={job.sourceFileName}>
          {job.docTitle || job.sourceFileName}
        </span>
        <span className="history-meta">
          {job.sourceFileType && (
            <span className="badge file">{job.sourceFileType}</span>
          )}
          {job.ocrUsed && <span className="badge ocr">OCR</span>}
          {typeof job.chunkCount === "number" && (
            <span className="history-chunks">{job.chunkCount} chunks</span>
          )}
          <span className="history-time" title={when.toLocaleString()}>
            {when.toLocaleString()}
          </span>
          <span className="history-dur">{fmtMs(sumMs)}</span>
          <span className={`status-tag ${job.status}`}>{job.status}</span>
        </span>
      </div>

      {open && (
        <div className="history-card-body">
          {steps.length > 0 ? (
            <div className="step-list">
              {steps.map((s, i) => {
                const meta = STEP_LABELS[s.step];
                const pct = Math.round(((s.ms ?? 0) / maxMs) * 100);
                const skipped =
                  s.status === "skipped" || s.status === "low_confidence";
                return (
                  <div className="step-row" key={`${s.step}-${i}`}>
                    <div className="step-row-head">
                      <span className="step-name" title={meta?.why}>
                        {stepLabel(s.step)}
                      </span>
                      <span className="step-ms">{fmtMs(s.ms)}</span>
                    </div>
                    <div className="step-bar-track">
                      <div
                        className={`step-bar-fill ${skipped ? "skipped" : ""}`}
                        style={{ width: `${Math.max(pct, s.ms ? 3 : 0)}%` }}
                      />
                    </div>
                    {(s.note || skipped) && (
                      <div className="step-note">
                        {skipped ? "skipped — " : ""}
                        {s.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty">No step trace recorded.</div>
          )}
          {job.errorMessage && (
            <div className="ingest-summary" style={{ color: "var(--red, #d33)" }}>
              {job.errorMessage}
            </div>
          )}
          <div className="ingest-summary">
            <span>server work: {fmtMs(sumMs)}</span>
            <span>job: {job.jobId}</span>
            <button className="mini-btn" onClick={() => setShowTrace((v) => !v)}>
              {showTrace ? "Hide raw trace" : "Show raw trace"}
            </button>
          </div>
          {showTrace && (
            <div style={{ marginTop: 8 }}>
              <CodeBlock value={job.steps} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
