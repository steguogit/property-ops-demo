"use client";

import React, { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

// Knowledge Policy Layer review view.
//
// Demonstrates the governed workflow the demo now uses instead of a static
// rule engine:
//   1. submit human feedback,
//   2. AI/heuristic drafts a CorrectionProposal (pending_review),
//   3. a reviewer APPROVES it into an active KnowledgePolicy,
//   4. active policies are applied deterministically at query time + traced.
//
// This is intentionally a compact data-model UI, not a full admin console.

interface Proposal {
  id: string;
  proposalType: string;
  status: string;
  proposedBy: string;
  term?: string | null;
  canonicalMeaning?: string | null;
  description: string;
  rationale: string;
  confidenceScore?: number | null;
  suggestedScope: any;
  suggestedPolicy: { matchConditions: any; actions: any; priority?: number };
  conflictPolicyIds?: string[] | null;
}

interface Policy {
  id: string;
  policyType: string;
  status: string;
  version: number;
  name: string;
  scope: any;
  matchConditions: any;
  actions: any;
  priority: number;
  conflictGroup?: string | null;
}

const FEEDBACK_TYPES = [
  "wrong_term_interpretation",
  "missing_document",
  "wrong_document_rank",
  "outdated_document",
  "source_should_be_boosted",
  "source_should_be_demoted",
  "incorrect_answer",
  "other",
];

export function PoliciesTab({ lastQuery }: { lastQuery?: string }) {
  const { t } = useI18n();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    feedbackType: "wrong_term_interpretation",
    queryText: lastQuery ?? "",
    feedbackText: "",
    propertyId: "",
    department: "",
    language: "zh-Hant",
    useLlm: false,
  });

  async function load() {
    setLoading(true);
    try {
      const [p, pol] = await Promise.all([
        fetch("/api/proposals?status=pending_review").then((r) => r.json()),
        fetch("/api/policies?status=active").then((r) => r.json()),
      ]);
      setProposals(p.proposals ?? []);
      setPolicies(pol.policies ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (lastQuery) setForm((f) => ({ ...f, queryText: lastQuery }));
  }, [lastQuery]);

  async function submitFeedback() {
    setNotice(null);
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedbackType: form.feedbackType,
        queryText: form.queryText,
        feedbackText: form.feedbackText,
        propertyId: form.propertyId || null,
        department: form.department || null,
        language: form.language || null,
        useLlm: form.useLlm,
        userId: "reviewer",
      }),
    });
    const data = await res.json();
    if (data.error) setNotice(data.error);
    else {
      setNotice(
        `Feedback stored and ${
          data.proposals?.length ?? 0
        } proposal(s) drafted (pending review). Nothing is active until you approve.`
      );
      setForm((f) => ({ ...f, feedbackText: "" }));
      await load();
    }
  }

  async function approve(p: Proposal) {
    await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        id: p.id,
        approvedBy: "reviewer",
      }),
    });
    await load();
  }
  async function reject(p: Proposal) {
    await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "reject",
        id: p.id,
        reviewedBy: "reviewer",
      }),
    });
    await load();
  }
  async function deactivate(pol: Policy) {
    await fetch("/api/policies", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deactivate",
        id: pol.id,
        deactivatedBy: "reviewer",
      }),
    });
    await load();
  }

  return (
    <div>
      <div className="panel">
        <h2>{t("pol.title")}</h2>
        <p className="sub">
          A governed, human-approved correction layer — <b>not</b> a static rule
          engine. AI <b>proposes</b>; a human <b>approves</b>; the runtime{" "}
          <b>applies approved policies deterministically</b> and records a trace.
        </p>
        {notice && <div className="notice info">{notice}</div>}

        <h3>1. Submit feedback</h3>
        <div className="form-grid">
          <div className="field">
            <label>Feedback type</label>
            <select
              value={form.feedbackType}
              onChange={(e) =>
                setForm({ ...form, feedbackType: e.target.value })
              }
            >
              {FEEDBACK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Query</label>
            <input
              value={form.queryText}
              onChange={(e) => setForm({ ...form, queryText: e.target.value })}
              placeholder="tenant says need 關水喉 for renovation"
            />
          </div>
          <div className="field">
            <label>Property (scope)</label>
            <input
              value={form.propertyId}
              onChange={(e) => setForm({ ...form, propertyId: e.target.value })}
              placeholder="grand-yoho"
            />
          </div>
          <div className="field">
            <label>Department (scope)</label>
            <input
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
              placeholder="maintenance"
            />
          </div>
          <div className="field full">
            <label>What was wrong?</label>
            <textarea
              rows={2}
              value={form.feedbackText}
              onChange={(e) =>
                setForm({ ...form, feedbackText: e.target.value })
              }
              placeholder="No, 關水喉 here means shutting the water supply valve, not closing the faucet."
            />
          </div>
          <div className="field full">
            <label>
              <input
                type="checkbox"
                checked={form.useLlm}
                onChange={(e) => setForm({ ...form, useLlm: e.target.checked })}
              />{" "}
              Use LLM to draft the proposal (else deterministic heuristic)
            </label>
          </div>
          <div className="field full">
            <button className="btn primary" onClick={submitFeedback}>
              {t("pol.submitFeedback")}
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>2. Proposals awaiting review ({proposals.length})</h3>
        <p className="sub">
          AI-drafted, <b>not active</b>. Approve to create a governed policy.
        </p>
        {loading && <div className="empty">Loading…</div>}
        {!loading && !proposals.length && (
          <div className="empty">No pending proposals.</div>
        )}
        <div className="correction-list">
          {proposals.map((p) => (
            <div key={p.id} className="correction-item">
              <div>
                <div className="ctype">
                  {p.proposalType} · by {p.proposedBy}
                  {p.confidenceScore != null &&
                    ` · confidence ${Math.round(p.confidenceScore * 100)}%`}
                </div>
                <div className="cbody">
                  {p.term && <b>{p.term}</b>}
                  {p.canonicalMeaning ? ` → ${p.canonicalMeaning}` : ""}
                  {!p.term && p.description}
                </div>
                {p.suggestedPolicy?.actions?.expandQueryWith?.length ? (
                  <div className="cscope">
                    expand with:{" "}
                    {p.suggestedPolicy.actions.expandQueryWith.join(", ")}
                  </div>
                ) : null}
                <div className="cscope">
                  rationale: {p.rationale}
                  {p.conflictPolicyIds?.length
                    ? ` · ⚠ ${p.conflictPolicyIds.length} conflict(s)`
                    : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="mini-btn" onClick={() => approve(p)}>
                  Approve
                </button>
                <button className="mini-btn" onClick={() => reject(p)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>3. Active policies ({policies.length})</h3>
        <p className="sub">
          Applied deterministically at query time. Deactivate to roll back
          (reversible, audited).
        </p>
        {!loading && !policies.length && (
          <div className="empty">No active policies.</div>
        )}
        <div className="correction-list">
          {policies.map((pol) => (
            <div key={pol.id} className="correction-item">
              <div>
                <div className="ctype">
                  {pol.policyType} · v{pol.version} · priority {pol.priority}
                </div>
                <div className="cbody">{pol.name}</div>
                <div className="cscope">
                  {pol.actions?.canonicalMeaning
                    ? `means: ${pol.actions.canonicalMeaning} · `
                    : ""}
                  scope:{" "}
                  {pol.scope?.propertyIds?.length
                    ? pol.scope.propertyIds.join(",")
                    : "any-property"}
                  {pol.scope?.departmentIds?.length
                    ? ` / ${pol.scope.departmentIds.join(",")}`
                    : ""}
                  {pol.conflictGroup ? ` · group ${pol.conflictGroup}` : ""}
                </div>
              </div>
              <button className="mini-btn" onClick={() => deactivate(pol)}>
                Deactivate
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
