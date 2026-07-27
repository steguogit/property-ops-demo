"use client";

import React, { useEffect } from "react";
import { useI18n } from "@/lib/i18n";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Pretty JSON with a copy button. */
export function CodeBlock({
  value,
  language = "json",
}: {
  value: unknown;
  language?: string;
}) {
  const { t } = useI18n();
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="codeblock">
      <button className="copy-btn" onClick={copy}>
        {copied ? t("common.copied") : t("common.copy")}
      </button>
      <pre data-lang={language}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
