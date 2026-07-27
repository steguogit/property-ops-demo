"use client";

import React, { useEffect, useRef, useState } from "react";
import { CodeBlock } from "./Modal";
import { FilePreviewDialog } from "./FilePreview";
import { useI18n } from "@/lib/i18n";

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
  const [docs, setDocs] = useState<DocumentDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<DocumentDoc | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentDoc | null>(null);
  const [job, setJob] = useState<any>(null);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(
    null
  );
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  // upload form metadata
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
      const res = await fetch("/api/documents");
      const data = await res.json();
      setDocs(data.documents ?? []);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Poll while any document's signature analysis is still pending (it runs
  // asynchronously after upload), so the badge updates without a manual refresh.
  useEffect(() => {
    const anyPending = docs.some((d) => d.signatureStatus === "pending");
    if (!anyPending) return;
    const id = setInterval(() => load(true), 4000);
    return () => clearInterval(id);
  }, [docs]);

  function pickFile(f: File | null) {
    setFile(f);
    if (f && !meta.title) {
      setMeta((m) => ({ ...m, title: f.name.replace(/\.[^.]+$/, "") }));
    }
  }

  async function upload() {
    if (!file) {
      setNotice({ kind: "warn", text: t("docs.chooseFirst") });
      return;
    }
    setUploading(true);
    setNotice(null);
    setJob(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      Object.entries(meta).forEach(([k, v]) => v && fd.append(k, v));
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) {
        setNotice({ kind: "warn", text: data.error });
      } else {
        setJob(data.job);
        setNotice({
          kind: "info",
          text: t("docs.ingested", {
            title: data.document.title,
            chunks: data.chunkCount,
            ocr: data.document.ocrUsed ? t("docs.ocrUsed") : t("docs.noOcr"),
            status: data.document.status,
          }),
        });
        setFile(null);
        await load();
      }
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    } finally {
      setUploading(false);
    }
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
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>{t("docs.uploadTitle")}</h2>
        <p className="sub">{t("docs.uploadSub")}</p>

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
              pickFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".pdf,.docx,.xlsx,.xls,.csv,.pptx,.png,.jpg,.jpeg,.webp,.tif,.tiff,.txt,.md"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <div>
                <b>{file.name}</b>
                <div className="types">
                  {t("docs.dropReplace", {
                    size: (file.size / 1024).toFixed(0),
                  })}
                </div>
              </div>
            ) : (
              <div>
                <b>{t("docs.dropPrompt")}</b> {t("docs.dropToIngest")}
                <div className="types">{t("docs.dropTypes")}</div>
              </div>
            )}
          </div>

          <div className="form-grid">
            <div className="field full">
              <label>{t("docs.title")}</label>
              <input
                value={meta.title}
                onChange={(e) => setMeta({ ...meta, title: e.target.value })}
                placeholder={t("docs.titlePlaceholder")}
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
                disabled={uploading}
              >
                {uploading ? (
                  <>
                    <span className="loading" /> {t("docs.uploading")}
                  </>
                ) : (
                  t("docs.uploadBtn")
                )}
              </button>
            </div>
          </div>
        </div>

        {job && (
          <div style={{ marginTop: 14 }}>
            <div className="stage-label">Ingestion job trace ({job.jobId})</div>
            <CodeBlock value={job.steps} />
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
