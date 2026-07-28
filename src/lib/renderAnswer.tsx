import React from "react";

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer for grounded RAG answers.
//
// The LLM is instructed to return:
//   - Markdown TABLES for any calculation/breakdown, and
//   - inline citations like [DOC-ID p.3] / [DOC-ID pp.3-5] for grounded facts.
//
// We render tables (pipe syntax), bullet/numbered lists, bold, and highlight
// citations — without pulling in a heavy markdown dependency. Anything not
// recognised is rendered as plain text (safe: no raw HTML is injected).
// ---------------------------------------------------------------------------

// Matches [DOC-ID], [DOC-ID p.3], [DOC-ID pp.3-5] (docId may contain A-Z 0-9 - _ #).
const CITE = /(\[[A-Za-z0-9][A-Za-z0-9\-_#]*(?:\s+p{1,2}\.\s?\d+(?:-\d+)?)?\])/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // First split on citations, then apply **bold** inside non-citation spans.
  const out: React.ReactNode[] = [];
  const parts = text.split(CITE);
  parts.forEach((p, i) => {
    if (!p) return;
    if (CITE.test(p) && /^\[/.test(p)) {
      out.push(
        <span className="cite" key={`${keyPrefix}-c${i}`}>
          {p}
        </span>
      );
      return;
    }
    // bold segments
    const bold = p.split(/(\*\*[^*]+\*\*)/g);
    bold.forEach((b, j) => {
      if (!b) return;
      if (/^\*\*[^*]+\*\*$/.test(b)) {
        out.push(<strong key={`${keyPrefix}-b${i}-${j}`}>{b.slice(2, -2)}</strong>);
      } else {
        out.push(
          <React.Fragment key={`${keyPrefix}-t${i}-${j}`}>{b}</React.Fragment>
        );
      }
    });
  });
  return out;
}

function isTableSeparator(line: string): boolean {
  // e.g. | --- | :--: | ---: |
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Render a grounded RAG answer with Markdown table + citation support.
 */
export function renderAnswer(text: string): React.ReactNode {
  const lines = (text ?? "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Markdown table: header row, separator row, then body rows ---
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitRow(line);
      const bodyRows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div className="answer-table-wrap" key={`tbl-${key++}`}>
          <table className="answer-table">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci}>{renderInline(c, `h${key}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{renderInline(c, `r${key}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // --- blank line → spacer ---
    if (!line.trim()) {
      blocks.push(<div className="answer-gap" key={`gap-${key++}`} />);
      i++;
      continue;
    }

    // --- everything else: a text line (lists/headings kept as-is text) ---
    blocks.push(
      <div className="answer-line" key={`ln-${key++}`}>
        {renderInline(line, `l${key}`)}
      </div>
    );
    i++;
  }

  return <>{blocks}</>;
}
