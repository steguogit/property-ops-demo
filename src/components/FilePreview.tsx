"use client";

import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

export interface PreviewTarget {
  documentId: string;
  sourceFileName?: string;
  sourceFileType?: string;
  title?: string;
  /** The exact retrieved chunk text — used to locate & highlight the passage. */
  highlightText?: string;
  /** 1-based page number of the retrieved passage, if known (PDF). */
  pageHint?: number;
}

/**
 * Normalise text for fuzzy matching: collapse whitespace, strip the `[Page N]`
 * markers we inject during OCR, and lowercase. This lets us locate the chunk in
 * the raw file even when extraction whitespace differs slightly.
 */
function normForMatch(s: string): string {
  return s
    .replace(/\[Page\s+\d+\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Find the character range in `haystack` that best corresponds to `needle`.
 * Tries, in order: whole-chunk match, then a shrinking prefix of the chunk,
 * then the chunk's longest sentence. Returns null when nothing is found.
 * Matching is whitespace- and case-insensitive.
 */
function locatePassage(
  haystack: string,
  needle: string
): { start: number; end: number } | null {
  if (!needle) return null;
  // Build a map from normalised-index -> original-index so we can translate a
  // match on the normalised string back to the raw file offsets.
  const map: number[] = [];
  let norm = "";
  let prevSpace = false;
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      norm += " ";
      map.push(i);
      prevSpace = true;
    } else {
      norm += ch.toLowerCase();
      map.push(i);
      prevSpace = false;
    }
  }
  const nNeedle = normForMatch(needle);
  const candidates: string[] = [];
  candidates.push(nNeedle);
  // Prefix candidates (handles chunks longer than what the file preserves).
  for (const len of [200, 120, 80, 50]) {
    if (nNeedle.length > len) candidates.push(nNeedle.slice(0, len));
  }
  // Longest "sentence" of the chunk as a last resort.
  const longest = nNeedle
    .split(/[.!?。！？\n]/)
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length)[0];
  if (longest && longest.length > 20) candidates.push(longest);

  for (const c of candidates) {
    const idx = norm.indexOf(c);
    if (idx >= 0) {
      const start = map[idx] ?? 0;
      const endNorm = Math.min(idx + c.length - 1, map.length - 1);
      const end = (map[endNorm] ?? start) + 1;
      return { start, end };
    }
  }
  return null;
}

/** Inline viewer for the original uploaded file (image / PDF / text / csv). */
export function FilePreview({ target }: { target: PreviewTarget }) {
  const { t } = useI18n();
  const type = target.sourceFileType ?? "unknown";
  // For PDFs, jump to the retrieved page if we know it (viewer fragment).
  const url =
    type === "pdf" && target.pageHint
      ? `/api/documents/${target.documentId}/file#page=${target.pageHint}`
      : `/api/documents/${target.documentId}/file`;
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const markRef = useRef<HTMLSpanElement | null>(null);
  const [located, setLocated] = useState<boolean | null>(null);

  useEffect(() => {
    setText(null);
    setErr(null);
    if (type === "text" || type === "csv") {
      setLoading(true);
      fetch(`/api/documents/${target.documentId}/file`)
        .then((r) =>
          r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))
        )
        .then(setText)
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.documentId]);

  // Once the text is rendered and we have a highlight target, scroll to it.
  useEffect(() => {
    if (markRef.current) {
      markRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [text, located]);

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
        {target.highlightText && (
          <div className="passage-callout">
            <div className="passage-callout-head">
              {t("preview.retrievedPassage")}
              {target.pageHint ? ` · p.${target.pageHint}` : ""}
            </div>
            <div className="passage-callout-body">{target.highlightText}</div>
          </div>
        )}
        <iframe
          src={url}
          title={target.sourceFileName ?? "pdf"}
          className="pdf-frame"
        />
      </div>
    );
  }

  if (type === "text" || type === "csv") {
    // Split the raw text around the located passage so we can wrap it in a
    // highlighted <mark> and scroll to it.
    let body: React.ReactNode = text;
    if (text != null && target.highlightText) {
      const loc = locatePassage(text, target.highlightText);
      if (loc) {
        if (located !== true) setTimeout(() => setLocated(true), 0);
        body = (
          <>
            {text.slice(0, loc.start)}
            <span className="passage-hit" ref={markRef}>
              {text.slice(loc.start, loc.end)}
            </span>
            {text.slice(loc.end)}
          </>
        );
      } else if (located !== false) {
        setTimeout(() => setLocated(false), 0);
      }
    }
    return (
      <div className="file-preview">
        {loading && <div className="empty">{t("preview.loading")}</div>}
        {err && <div className="err">{err}</div>}
        {text != null && target.highlightText && (
          <div
            className={`passage-locator ${located === false ? "warn" : ""}`}
          >
            {located === false
              ? t("preview.passageNotFound")
              : t("preview.jumpedToPassage")}
          </div>
        )}
        {text != null && <pre className="text-preview">{body}</pre>}
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
