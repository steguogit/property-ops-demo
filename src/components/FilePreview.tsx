"use client";

import React, { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

export interface PreviewTarget {
  documentId: string;
  sourceFileName?: string;
  sourceFileType?: string;
  title?: string;
}

/** Inline viewer for the original uploaded file (image / PDF / text / csv). */
export function FilePreview({ target }: { target: PreviewTarget }) {
  const { t } = useI18n();
  const url = `/api/documents/${target.documentId}/file`;
  const type = target.sourceFileType ?? "unknown";
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setErr(null);
    if (type === "text" || type === "csv") {
      setLoading(true);
      fetch(url)
        .then((r) =>
          r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))
        )
        .then(setText)
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.documentId]);

  if (type === "image") {
    return (
      <div className="file-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={target.sourceFileName ?? "image"} />
      </div>
    );
  }

  if (type === "pdf") {
    return (
      <div className="file-preview">
        <iframe
          src={url}
          title={target.sourceFileName ?? "pdf"}
          className="pdf-frame"
        />
      </div>
    );
  }

  if (type === "text" || type === "csv") {
    return (
      <div className="file-preview">
        {loading && <div className="empty">{t("preview.loading")}</div>}
        {err && <div className="err">{err}</div>}
        {text != null && <pre className="text-preview">{text}</pre>}
      </div>
    );
  }

  return (
    <div className="file-preview">
      <div className="notice info" style={{ margin: 0 }}>
        <b>{type.toUpperCase()}</b> — {t("preview.cannotRender")}
      </div>
    </div>
  );
}

/** Fullscreen popup dialog wrapping FilePreview. */
export function FilePreviewDialog({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !target) return null;
  const url = `/api/documents/${target.documentId}/file`;

  return (
    <div className="fs-backdrop" onClick={onClose}>
      <div className="fs-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="fs-head">
          <div className="fs-titles">
            <h2>{target.title ?? target.sourceFileName ?? t("preview.title")}</h2>
            <p>
              {target.sourceFileName}
              {target.sourceFileType ? ` · ${target.sourceFileType}` : ""}
            </p>
          </div>
          <div className="fs-actions">
            <a
              className="btn sm"
              href={`${url}?download=1`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none" }}
            >
              {t("common.download")}
            </a>
            <button
              className="fs-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
        <div className="fs-body">
          <FilePreview target={target} />
        </div>
      </div>
    </div>
  );
}

/** File types that have a renderable / meaningful preview. */
export function isPreviewable(fileType?: string): boolean {
  return ["image", "pdf", "csv", "text"].includes(fileType ?? "");
}
