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

function highlight(text: string, terms: string[]) {
  if (!terms?.length) return text;
  const sorted = [...new Set(terms)].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) =>
    sorted.some((t) => t.toLowerCase() === p.toLowerCase()) ? (
      <mark key={i}>{p}</mark>
    ) : (
      <React.Fragment key={i}>{p}</React.Fragment>
    )
  );
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
}: {
  hit: Hit;
  onPreview?: (target: PreviewTarget) => void;
}) {
  const { t } = useI18n();
  const matched = hit.matchedTerms ?? [];
  // Only uploaded documents (DOC-*) have an original file stored in GridFS.
  const canPreview =
    !!onPreview &&
    !!hit.documentId &&
    hit.documentId.startsWith("DOC-") &&
    isPreviewable(hit.sourceFileType);
  return (
    <div className="card">
      <div className="top">
        <span className="rank">#{hit.rank}</span>
        <span className="title">{hit.title}</span>
        <span className="score">{hit.score.toFixed(4)}</span>
      </div>

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

      <div className="excerpt">{highlight(hit.chunkText, matched)}</div>

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
