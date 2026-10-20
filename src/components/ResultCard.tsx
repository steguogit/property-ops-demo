"use client";

import React from "react";
import { isPreviewable, PreviewTarget } from "./FilePreview";
import { useI18n } from "@/lib/i18n";

export interface Hit {
  docId: string;
  chunkIndex: number;
  title: string;
  docType: string;
  propertyName: string;
  propertyAliases: string[];
  segment: string;
  language: string[];
  audience?: string[];
  tags: string[];
  exactTerms: string[];
  extractedFields?: Record<string, string>;
  chunkText: string;
  updatedAt?: string;
  documentId?: string;
  sourceFileType?: string;
  versionLabel?: string;
  versionGroupId?: string;
  obsoleteFlag?: boolean;
  effectiveFrom?: string;
  ocrUsed?: boolean;
  score: number;
  rank: number;
  vectorScore?: number;
  lexicalScore?: number;
  rerankScore?: number;
  matchedTerms?: string[];
  correctionNote?: string;
}

// Common words to skip so highlighting focuses on meaningful query keywords.
const STOP = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "are",
  "what", "how", "when", "where", "which", "who", "with", "at", "by", "from",
  "list", "show", "the", "please", "me", "my", "i", "do", "does", "as",
]);

/** Tokenise a query into highlightable keywords (words + CJK runs). */
function queryTerms(query?: string): string[] {
  if (!query) return [];
  const out: string[] = [];
  // Latin words length>=2 (skip stopwords) + CJK character runs.
  const re = /[A-Za-z0-9]{2,}|[\u3400-\u9FFF\uF900-\uFAFF]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const w = m[0];
    if (/^[A-Za-z]+$/.test(w) && STOP.has(w.toLowerCase())) continue;
    out.push(w);
  }
  return [...new Set(out)];
}

/**
 * Highlight matched exact-terms strongly (<mark class="strong">) and query
 * keywords softly (<mark>). Works even for pure vector search (no lexical
 * matches) by falling back to query-keyword highlighting.
 */
function highlight(text: string, strongTerms: string[], softTerms: string[]) {
  const all = [
    ...new Set([...strongTerms, ...softTerms].filter(Boolean)),
  ].sort((a, b) => b.length - a.length);
  if (!all.length) return text;
  const strongSet = new Set(strongTerms.map((s) => s.toLowerCase()));
  const escaped = all.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) => {
    const lower = p.toLowerCase();
    const isMatch = all.some((t) => t.toLowerCase() === lower);
    if (!isMatch) return <React.Fragment key={i}>{p}</React.Fragment>;
    return strongSet.has(lower) ? (
      <mark className="hl-strong" key={i}>
        {p}
      </mark>
    ) : (
      <mark key={i}>{p}</mark>
    );
  });
}

/** Best-effort 1-based page number for a hit (for PDF deep-linking). */
function pageHintFor(hit: Hit): number | undefined {
  const m = /\[Page\s+(\d+)\]/i.exec(hit.chunkText || "");
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const TYPE_LABEL: Record<string, string> = {
  property_alias_master: "Alias Master",
  duty_roster: "Duty Roster",
  incident_report: "Incident",
  sop: "SOP",
  faq: "FAQ / Handbook",
  contractor_procedure: "Contractor Proc.",
  om_manual: "O&M Manual",
  floor_plan: "Floor Plan",
  technician_guide: "Technician Guide",
  utility_export: "Utility CSV",
  uploaded_document: "Uploaded Doc",
};

export function ResultCard({
  hit,
  onPreview,
  onViewDoc,
  query,
}: {
  hit: Hit;
  onPreview?: (target: PreviewTarget) => void;
  /** Open a dialog showing the actual MongoDB document for this chunk. */
  onViewDoc?: (id: string) => void;
  /** The search/answer query — its keywords are softly highlighted in the excerpt. */
  query?: string;
}) {
  const { t } = useI18n();
  const matched = hit.matchedTerms ?? [];
  const soft = queryTerms(query);
  // Only uploaded documents (DOC-*) have an original file stored in GridFS.
  const canPreview =
    !!onPreview &&
    !!hit.documentId &&
    hit.documentId.startsWith("DOC-") &&
    isPreviewable(hit.sourceFileType);
  // Show a thumbnail for IMAGE documents (so image-search results are visual).
  const showImageThumb =
    !!hit.documentId &&
    hit.documentId.startsWith("DOC-") &&
    hit.sourceFileType === "image";
  return (
    <div className="card">
      <div className="top">
        <span className="rank">#{hit.rank}</span>
        <span className="title">{hit.title}</span>
        {onViewDoc && (
          <button
            type="button"
            className="doc-json-btn"
            title={t("card.viewDoc")}
            aria-label={t("card.viewDoc")}
            onClick={() => onViewDoc(`${hit.docId}#${hit.chunkIndex}`)}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8" />
              <path d="M8 17h8" />
              <path d="M8 9h2" />
            </svg>
          </button>
        )}
        <span className="score">{hit.score.toFixed(4)}</span>
      </div>

      {showImageThumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="card-image-thumb"
          src={`/api/documents/${hit.documentId}/file`}
          alt={hit.title}
          style={{
            marginTop: 8,
            maxWidth: "100%",
            maxHeight: 160,
            borderRadius: 8,
            border: "1px solid var(--border)",
            objectFit: "contain",
            cursor: canPreview ? "pointer" : "default",
          }}
          onClick={() =>
            canPreview &&
            onPreview!({
              documentId: hit.documentId!,
              sourceFileName: hit.title,
              sourceFileType: hit.sourceFileType,
              title: hit.title,
              highlightText: hit.chunkText,
              pageHint: pageHintFor(hit),
            })
          }
        />
      )}

      <div className="badges">
        <span className="badge type">{TYPE_LABEL[hit.docType] ?? hit.docType}</span>
        {hit.propertyName && hit.propertyName !== "Portfolio-wide" && (
          <span className="badge prop">{hit.propertyName}</span>
        )}
        <span className="badge">{hit.docId}</span>
        {hit.versionLabel && (
          <span className="badge ver" title={hit.effectiveFrom ? `effective ${hit.effectiveFrom}` : undefined}>
            {hit.versionLabel}
          </span>
        )}
        {hit.obsoleteFlag && (
          <span className="badge obsolete">{t("card.obsolete")}</span>
        )}
        {hit.ocrUsed && <span className="badge ocr">{t("card.ocr")}</span>}
        {hit.sourceFileType && hit.sourceFileType !== "text" && (
          <span className="badge file">{hit.sourceFileType}</span>
        )}
        {hit.correctionNote && (
          <span className="badge correction">⚑ {hit.correctionNote}</span>
        )}
        {matched.map((t) => (
          <span className="badge match" key={t}>
            ✓ {t}
          </span>
        ))}
      </div>

      <div className="excerpt">{highlight(hit.chunkText, matched, soft)}</div>

      {canPreview && (
        <button
          className="btn sm preview-btn"
          style={{ marginTop: 8 }}
          onClick={() =>
            onPreview!({
              documentId: hit.documentId!,
              sourceFileName: hit.title,
              sourceFileType: hit.sourceFileType,
              title: hit.title,
              highlightText: hit.chunkText,
              pageHint: pageHintFor(hit),
            })
          }
        >
          {t("card.previewType", { type: hit.sourceFileType ?? "" })}
        </button>
      )}

      <div className="scorebar">
        {hit.vectorScore != null && (
          <span>
            <b>vec</b> {hit.vectorScore.toFixed(3)}
          </span>
        )}
        {hit.lexicalScore != null && (
          <span>
            <b>lex</b> {hit.lexicalScore.toFixed(2)}
          </span>
        )}
        {hit.rerankScore != null && (
          <span>
            <b>rerank</b> {hit.rerankScore.toFixed(3)}
          </span>
        )}
      </div>
    </div>
  );
}
