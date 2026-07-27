"use client";

import React, { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

interface Correction {
  correctionId: string;
  type: string;
  query?: string;
  term?: string;
  correctedMeaning?: string;
  targetDocId?: string;
  preferredVersionLabel?: string;
  note?: string;
  active: boolean;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  term_meaning: "Term meaning",
  wrong_interpretation: "Wrong interpretation",
  prefer_source: "Prefer source",
  demote_source: "Demote source",
  prefer_version: "Prefer version",
};

export function CorrectionsTab({ lastQuery }: { lastQuery?: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Correction[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    type: "term_meaning",
    query: lastQuery ?? "",
    term: "",
    correctedMeaning: "",
    targetDocId: "",
    preferredVersionLabel: "",
    note: "",
  });
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/corrections");
      const data = await res.json();
      setItems(data.corrections ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (lastQuery) setForm((f) => ({ ...f, query: lastQuery }));
  }, [lastQuery]);

  async function submit() {
    setNotice(null);
    const res = await fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (data.error) {
      setNotice(data.error);
    } else {
      setNotice("Correction saved — it now shapes retrieval at the data layer.");
      setForm((f) => ({
        ...f,
        term: "",
        correctedMeaning: "",
        targetDocId: "",
        preferredVersionLabel: "",
        note: "",
      }));
      await load();
    }
  }

  async function toggle(c: Correction) {
    await fetch("/api/corrections", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correctionId: c.correctionId, active: !c.active }),
    });
    await load();
  }

  const ctype = form.type;

  return (
    <div>
      <div className="panel">
        <h2>{t("corr.title")}</h2>
        <p className="sub">
          Corrections are applied at the <b>data layer</b> — they re-order
          results, clarify term meanings, and prefer versions{" "}
          <b>without anyone editing a prompt</b>. Every correction is reversible
          and shown in the &ldquo;Show query&rdquo; explainer.
        </p>

        {notice && <div className="notice info">{notice}</div>}

        <div className="form-grid">
          <div className="field">
            <label>{t("corr.type")}</label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Scope to query / topic (optional)</label>
            <input
              value={form.query}
              onChange={(e) => setForm({ ...form, query: e.target.value })}
              placeholder="leave blank for global"
            />
          </div>

          {ctype === "term_meaning" && (
            <>
              <div className="field">
                <label>Term</label>
                <input
                  value={form.term}
                  onChange={(e) => setForm({ ...form, term: e.target.value })}
                  placeholder="關水喉"
                />
              </div>
              <div className="field">
                <label>Correct meaning</label>
                <input
                  value={form.correctedMeaning}
                  onChange={(e) =>
                    setForm({ ...form, correctedMeaning: e.target.value })
                  }
                  placeholder="shut off the water supply valve (not 'close a faucet')"
                />
              </div>
            </>
          )}

          {(ctype === "prefer_source" ||
            ctype === "demote_source" ||
            ctype === "wrong_interpretation") && (
            <div className="field">
              <label>Target docId</label>
              <input
                value={form.targetDocId}
                onChange={(e) =>
                  setForm({ ...form, targetDocId: e.target.value })
                }
                placeholder="SOP-WATER-RES-001 or DOC-..."
              />
            </div>
          )}

          {ctype === "prefer_version" && (
            <>
              <div className="field">
                <label>Preferred version label</label>
                <input
                  value={form.preferredVersionLabel}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      preferredVersionLabel: e.target.value,
                    })
                  }
                  placeholder="v2023.1"
                />
              </div>
              <div className="field">
                <label>Target docId (optional)</label>
                <input
                  value={form.targetDocId}
                  onChange={(e) =>
                    setForm({ ...form, targetDocId: e.target.value })
                  }
                />
              </div>
            </>
          )}

          <div className="field full">
            <label>Note (why)</label>
            <textarea
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Reviewer rationale, for audit."
            />
          </div>
          <div className="field full">
            <button className="btn primary" onClick={submit}>
              {t("corr.save")}
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Active &amp; past corrections ({items.length})</h2>
        <p className="sub">
          Toggle a correction off to instantly remove its effect on retrieval.
        </p>
        {loading && <div className="empty">{t("common.loading")}</div>}
        {!loading && !items.length && (
          <div className="empty">{t("corr.empty")}</div>
        )}
        <div className="correction-list">
          {items.map((c) => (
            <div
              key={c.correctionId}
              className={`correction-item ${c.active ? "" : "inactive"}`}
            >
              <div>
                <div className="ctype">{TYPE_LABELS[c.type] ?? c.type}</div>
                <div className="cbody">
                  {c.type === "term_meaning" &&
                    `"${c.term}" → ${c.correctedMeaning}`}
                  {(c.type === "prefer_source" ||
                    c.type === "demote_source" ||
                    c.type === "wrong_interpretation") &&
                    c.targetDocId}
                  {c.type === "prefer_version" &&
                    `prefer "${c.preferredVersionLabel}"${
                      c.targetDocId ? ` (${c.targetDocId})` : ""
                    }`}
                </div>
                <div className="cscope">
                  scope: {c.query ? `"${c.query}"` : "global"}
                  {c.note ? ` · ${c.note}` : ""}
                </div>
              </div>
              <button className="mini-btn" onClick={() => toggle(c)}>
                {c.active ? t("common.disable") : t("common.enable")}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
