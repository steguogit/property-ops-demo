"use client";

import React, { useEffect, useRef, useState } from "react";
import { ResultCard, Hit } from "./ResultCard";
import { FilePreviewDialog, PreviewTarget } from "./FilePreview";
import { useI18n } from "@/lib/i18n";

interface ConversationSummary {
  conversationId: string;
  title: string;
  messageCount: number;
  lastMessagePreview?: string;
  updatedAt: string;
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

interface ChatMessage {
  role: "user" | "assistant";
  messageText: string;
  messageIndex?: number;
  // Assistant-turn extras (present only for the latest live answer).
  sources?: Hit[];
  recalled?: Recalled[];
  llmUsed?: boolean;
  mode?: string;
  pending?: boolean;
}

function renderAnswer(text: string) {
  const parts = text.split(/(\[[A-Z0-9-]+\])/g);
  return parts.map((p, i) =>
    /^\[[A-Z0-9-]+\]$/.test(p) ? (
      <span className="cite" key={i}>
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

export function ChatTab() {
  const { t } = useI18n();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [recallAll, setRecallAll] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(
    null
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks which conversation the UI is currently showing, so an in-flight
  // send() can tell whether the user has switched away before it resolved.
  const activeConvRef = useRef<string | null>(null);
  activeConvRef.current = conversationId;
  // Tracks an in-flight send() so that switching back to that thread while the
  // LLM is still thinking re-shows the pending "thinking…" bubble.
  const pendingRef = useRef<{ convId: string; query: string } | null>(null);

  async function loadConversations() {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadConversations();
  }, []);

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
        body: JSON.stringify({}),
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
        <div className="chat-conv-list">
          {conversations.length === 0 && (
            <div className="empty">{t("chat.noConversations")}</div>
          )}
          {conversations.map((c) => (
            <div
              key={c.conversationId}
              className={`chat-conv-item ${
                conversationId === c.conversationId ? "active" : ""
              }`}
              onClick={() => openConversation(c.conversationId)}
            >
              <div className="chat-conv-title">{c.title}</div>
              <div className="chat-conv-meta">
                {t("chat.turns", { n: c.messageCount })}
              </div>
              <button
                className="chat-conv-del"
                title={t("common.delete")}
                onClick={(e) => {
                  e.stopPropagation();
                  removeConversation(c.conversationId);
                }}
              >
                ×
              </button>
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
                  <span className="loading" />
                ) : m.role === "assistant" ? (
                  <div className="text">{renderAnswer(m.messageText)}</div>
                ) : (
                  m.messageText
                )}

                {/* Assistant extras: recalled memory + sources */}
                {m.role === "assistant" && !m.pending && (
                  <>
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
