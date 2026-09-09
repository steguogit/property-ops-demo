"use client";

import React, { useEffect, useRef, useState } from "react";
import { ResultCard, Hit } from "./ResultCard";
import { FilePreviewDialog, PreviewTarget } from "./FilePreview";
import { useI18n } from "@/lib/i18n";
import { useDataset } from "@/lib/dataset-context";
import { renderAnswer } from "@/lib/renderAnswer";

interface ConversationSummary {
  conversationId: string;
  title: string;
  autoTitled?: boolean;
  messageCount: number;
  lastMessagePreview?: string;
  updatedAt: string;
}

/**
 * Live "thinking" panel shown while the LLM generates. The /api/chat call is
 * non-streaming, so we advance through the KNOWN pipeline phases on a timer with
 * a running elapsed counter, so the wait shows what's happening instead of a
 * bare spinner. The real per-step timings appear afterward in "Pipeline steps".
 */
function ChatThinking({ t }: { t: (k: string, v?: any) => string }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setMs(Date.now() - start), 150);
    return () => clearInterval(id);
  }, []);
  const phases = [
    { key: "chat.phase.store", at: 0 },
    { key: "chat.phase.recall", at: 500 },
    { key: "chat.phase.retrieve", at: 1200 },
    { key: "chat.phase.generate", at: 2400 },
  ];
  let active = 0;
  for (let i = 0; i < phases.length; i++) if (ms >= phases[i].at) active = i;
  return (
    <div className="chat-thinking">
      <div className="chat-thinking-head">
        <span className="loading" />
        <span className="chat-thinking-time">
          {t("sig.elapsed", { s: (ms / 1000).toFixed(1) })}
        </span>
      </div>
      <div className="chat-thinking-steps">
        {phases.map((p, i) => (
          <div
            key={p.key}
            className={`chat-thinking-step ${
              i < active ? "done" : i === active ? "active" : "pending"
            }`}
          >
            <span className="chat-thinking-dot" />
            {t(p.key)}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Recalled {
  conversationId: string;
  messageIndex: number;
  role: "user" | "assistant";
  messageText: string;
  createdAt: string;
  score: number;
  via: string;
}

interface ChatModel {
  role: string;
  name: string;
}
interface ChatStep {
  step: string;
  ms: number;
  note?: string;
}
interface ChatMessage {
  role: "user" | "assistant";
  messageText: string;
  messageIndex?: number;
  // Assistant-turn extras (present only for the latest live answer).
  sources?: Hit[];
  recalled?: Recalled[];
  llmUsed?: boolean;
  mode?: string;
  models?: ChatModel[];
  steps?: ChatStep[];
  /** The user question this answer responded to (for keyword highlighting). */
  query?: string;
  pending?: boolean;
}

export function ChatTab() {
  const { t } = useI18n();
  const { activeId: datasetId } = useDataset();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [recallAll, setRecallAll] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(
    null
  );
  const [convSearch, setConvSearch] = useState("");
  // Inline rename state: which conversation is being renamed + the draft.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks which conversation the UI is currently showing, so an in-flight
  // send() can tell whether the user has switched away before it resolved.
  const activeConvRef = useRef<string | null>(null);
  activeConvRef.current = conversationId;
  // Tracks an in-flight send() so that switching back to that thread while the
  // LLM is still thinking re-shows the pending "thinking…" bubble.
  const pendingRef = useRef<{ convId: string; query: string } | null>(null);

  async function loadConversations(search?: string) {
    try {
      const q = (search ?? convSearch).trim();
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("datasetId", datasetId);
      const res = await fetch(`/api/conversations?${params.toString()}`);
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload (and reset to a fresh thread) when the active demo dataset changes —
  // conversations from other demos must not appear here.
  useEffect(() => {
    activeConvRef.current = null;
    setConversationId(null);
    setMessages([]);
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // Debounced search of the conversation list.
  useEffect(() => {
    const id = setTimeout(() => loadConversations(convSearch), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convSearch]);

  useEffect(() => {
    // Auto-scroll to the newest message.
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function openConversation(id: string) {
    activeConvRef.current = id;
    setConversationId(id);
    setMessages([]);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
      // Ignore if the user switched away while this was loading.
      if (activeConvRef.current !== id) return;
      const loaded: ChatMessage[] = (data.messages ?? []).map((m: any) => ({
        role: m.role,
        messageText: m.messageText,
        messageIndex: m.messageIndex,
      }));
      // If this thread has a still-in-flight answer, the assistant turn isn't
      // persisted yet — re-show the optimistic user turn + thinking bubble so
      // the "thinking…" spinner doesn't vanish when switching back.
      const pend = pendingRef.current;
      if (pend && pend.convId === id) {
        const hasUser = loaded.some(
          (m) => m.role === "user" && m.messageText === pend.query
        );
        if (!hasUser) {
          loaded.push({ role: "user", messageText: pend.query });
        }
        loaded.push({ role: "assistant", messageText: "", pending: true });
      }
      setMessages(loaded);
    } catch {
      /* ignore */
    }
  }

  async function newConversation() {
    setInput("");
    // Create the thread immediately so it shows up in the sidebar right away
    // (instead of only appearing after the first message is sent). Switch the
    // active conversation FIRST (via the ref) so any in-flight send() resolving
    // for the previous thread won't write its answer into this new one.
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetId }),
      });
      const data = await res.json();
      const newId = data.conversation?.conversationId ?? null;
      activeConvRef.current = newId;
      setConversationId(newId);
      setMessages([]);
      await loadConversations();
    } catch {
      activeConvRef.current = null;
      setConversationId(null);
      setMessages([]);
    }
  }

  async function removeConversation(id: string) {
    if (!window.confirm(t("chat.deleteConfirm"))) return;
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
    // If we deleted the open thread, just clear the view — do NOT auto-create a
    // new one (that made it look like the delete "did nothing").
    if (conversationId === id) {
      activeConvRef.current = null;
      setConversationId(null);
      setMessages([]);
    }
    await loadConversations();
  }

  function startRename(id: string, current: string) {
    setRenamingId(id);
    setRenameDraft(current);
  }

  async function commitRename() {
    const id = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!id || !title) return;
    // Optimistic update.
    setConversations((cs) =>
      cs.map((c) => (c.conversationId === id ? { ...c, title } : c))
    );
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      /* ignore */
    }
    await loadConversations();
  }

  // Auto-title is generated server-side after the first turn (async), so poll
  // the conversation list a few times until the topic title appears.
  function pollForTitle(id: string) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      await loadConversations();
      const c = (await (await fetch(`/api/conversations/${id}`)).json())
        ?.conversation;
      if ((c && c.autoTitled) || tries >= 6) clearInterval(timer);
    }, 2000);
  }

  async function send() {
    const q = input.trim();
    if (!q || sending) return;
    // Capture which conversation this turn belongs to. If the user switches to
    // (or creates) another conversation while the LLM is thinking, we must NOT
    // write the answer into whatever thread is showing then.
    const sendConvId = conversationId;
    setInput("");
    setSending(true);
    // Remember this in-flight turn so switching back to its thread re-shows the
    // thinking bubble. (For a brand-new thread we set the id once we have it.)
    if (sendConvId) pendingRef.current = { convId: sendConvId, query: q };
    // Optimistically show the user's turn + a pending assistant bubble.
    setMessages((m) => [
      ...m,
      { role: "user", messageText: q },
      { role: "assistant", messageText: "", pending: true },
    ]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          conversationId: sendConvId ?? undefined,
          recallFromAllConversations: recallAll,
          datasetId,
        }),
      });
      const data = await res.json();
      const resolvedConvId = sendConvId ?? data.conversationId ?? null;

      // First turn of a brand-new thread: adopt the server-created id, but only
      // if the user hasn't navigated away in the meantime.
      if (!sendConvId && data.conversationId && activeConvRef.current === null) {
        activeConvRef.current = data.conversationId;
        setConversationId(data.conversationId);
      }
      // A topic title is generated async after the first turn — poll for it.
      if (data.isNewConversation && resolvedConvId) {
        pollForTitle(resolvedConvId);
      }
      // Now that we know the id, keep the in-flight marker accurate.
      if (resolvedConvId && pendingRef.current?.convId !== resolvedConvId) {
        pendingRef.current = { convId: resolvedConvId, query: q };
      }

      // Only touch the visible messages if the user is still on this thread.
      // Otherwise the turn is already persisted server-side and will appear when
      // they navigate back to it.
      if (activeConvRef.current === resolvedConvId) {
        setMessages((m) => {
          const copy = [...m];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant" && copy[i].pending) {
              copy[i] = {
                role: "assistant",
                messageText: data.error
                  ? `⚠ ${data.error}`
                  : data.answer ?? "(no answer)",
                sources: data.sources ?? [],
                recalled: data.recalled ?? [],
                llmUsed: data.llmUsed,
                mode: data.mode,
                models: data.models ?? [],
                steps: data.steps ?? [],
                query: q,
              };
              break;
            }
          }
          return copy;
        });
      }
      await loadConversations();
    } catch (e) {
      if (activeConvRef.current === sendConvId) {
        setMessages((m) => {
          const copy = [...m];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant" && copy[i].pending) {
              copy[i] = {
                role: "assistant",
                messageText: `⚠ ${(e as Error).message}`,
              };
              break;
            }
          }
          return copy;
        });
      }
    } finally {
      setSending(false);
      pendingRef.current = null;
    }
  }

  return (
    <div className="chat-layout">
      {/* Sidebar: conversation list */}
      <aside className="chat-sidebar">
        <button className="btn primary chat-new" onClick={newConversation}>
          + {t("chat.newConversation")}
        </button>
        <input
          className="chat-conv-search"
          value={convSearch}
          placeholder={t("chat.searchConversations")}
          onChange={(e) => setConvSearch(e.target.value)}
        />
        <div className="chat-conv-list">
          {conversations.length === 0 && (
            <div className="empty">
              {convSearch.trim()
                ? t("chat.noMatches")
                : t("chat.noConversations")}
            </div>
          )}
          {conversations.map((c) => (
            <div
              key={c.conversationId}
              className={`chat-conv-item ${
                conversationId === c.conversationId ? "active" : ""
              }`}
              onClick={() =>
                renamingId !== c.conversationId &&
                openConversation(c.conversationId)
              }
            >
              {renamingId === c.conversationId ? (
                <input
                  className="chat-conv-rename"
                  value={renameDraft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <div className="chat-conv-title">{c.title}</div>
              )}
              <div className="chat-conv-meta">
                {t("chat.turns", { n: c.messageCount })}
              </div>
              <div className="chat-conv-actions">
                <button
                  className="chat-conv-btn"
                  title={t("chat.rename")}
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(c.conversationId, c.title);
                  }}
                >
                  ✎
                </button>
                <button
                  className="chat-conv-btn"
                  title={t("common.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeConversation(c.conversationId);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main: messages + composer */}
      <div className="chat-main">
        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty chat-empty">{t("chat.empty")}</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              <div className="chat-bubble">
                {m.pending ? (
                  <ChatThinking t={t} />
                ) : m.role === "assistant" ? (
                  <div className="text">{renderAnswer(m.messageText)}</div>
                ) : (
                  m.messageText
                )}

                {/* Assistant extras: models, steps, recalled memory + sources */}
                {m.role === "assistant" && !m.pending && (
                  <>
                    {!!m.models?.length && (
                      <div className="chat-models">
                        {m.models.map((mo, j) => (
                          <span className="chat-model-chip" key={j}>
                            <span className="chat-model-role">{mo.role}</span>
                            {mo.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {!!m.steps?.length && (
                      <details className="chat-steps">
                        <summary className="chat-steps-head">
                          ⚙ {t("chat.steps", { n: m.steps.length })}
                        </summary>
                        <div className="chat-steps-body">
                          {m.steps.map((s, j) => (
                            <div className="chat-step-item" key={j}>
                              <span className="chat-step-dot" />
                              <span className="chat-step-name">{s.step}</span>
                              <span className="chat-step-ms">{s.ms} ms</span>
                              {s.note && (
                                <span className="chat-step-note">
                                  {" "}
                                  — {s.note}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {!!m.recalled?.length && (
                      <details className="chat-recalled">
                        <summary className="chat-recalled-head">
                          🧠 {t("chat.recalledMemory", { n: m.recalled.length })}
                        </summary>
                        <div className="chat-recalled-body">
                          {m.recalled.map((r, j) => (
                            <div className="chat-recalled-item" key={j}>
                              <span className={`badge ${r.via}`}>{r.via}</span>{" "}
                              <span className="chat-recalled-role">
                                {r.role}
                              </span>{" "}
                              {r.messageText.slice(0, 90)}
                              {r.messageText.length > 90 ? "…" : ""}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {!!m.sources?.length && (
                      <details className="chat-sources">
                        <summary>
                          {t("chat.sources", { n: m.sources.length })}
                        </summary>
                        <div className="chat-sources-grid">
                          {m.sources.slice(0, 4).map((h) => (
                            <ResultCard
                              hit={h}
                              onPreview={setPreviewTarget}
                              query={m.query}
                              key={`${h.docId}#${h.chunkIndex}`}
                            />
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="chat-composer">
          <label className="chat-recall-toggle" title={t("chat.recallAllTitle")}>
            <input
              type="checkbox"
              checked={recallAll}
              onChange={(e) => setRecallAll(e.target.checked)}
            />
            {t("chat.recallAll")}
          </label>
          <div className="chat-input-row">
            <input
              className="query-input"
              value={input}
              placeholder={t("chat.placeholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Send with Cmd/Ctrl + Enter.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={sending}
            />
            <button
              className="btn primary chat-send-btn"
              onClick={send}
              disabled={sending || !input.trim()}
            >
              {sending ? <span className="loading" /> : t("chat.send")}
            </button>
          </div>
        </div>
      </div>

      <FilePreviewDialog
        open={!!previewTarget}
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
}
