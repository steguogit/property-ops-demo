"use client";

import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

interface SignatureItem {
  signatureId: string;
  signerName: string;
  label?: string;
  originalFileId?: string;
  cropRect?: Rect | null;
  createdAt: string;
}

interface MatchItem {
  signatureId: string;
  signerName: string;
  label?: string;
  originalFileId?: string;
  cropRect?: Rect | null;
  similarity: number;
  band: "match" | "review" | "no_match";
}

/** Per-region comparison result: the best matches for ONE detected region. */
interface RegionResult {
  regionIndex: number;
  cropRect: Rect;
  matches: MatchItem[];
  best: MatchItem | null;
}

/** Enlarged signature viewer: full image with the embedded region boxed. */
interface ViewerTarget {
  src: string;
  title: string;
  subtitle?: string;
  cropRect?: Rect | null;
}

function SignatureViewer({
  target,
  onClose,
}: {
  target: ViewerTarget | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const imgRef = useRef<HTMLImageElement>(null);
  // Box position in PIXELS relative to the rendered image (recomputed on load /
  // resize) so it never drifts due to letterboxing or layout.
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const c = target?.cropRect;

  const recompute = React.useCallback(() => {
    const im = imgRef.current;
    if (!im || !c || c.w <= 0.005 || c.h <= 0.005) {
      setBox(null);
      return;
    }
    setBox({
      left: c.x * im.clientWidth,
      top: c.y * im.clientHeight,
      width: c.w * im.clientWidth,
      height: c.h * im.clientHeight,
    });
  }, [c]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", recompute);
    };
  }, [target, onClose, recompute]);

  if (!target) return null;
  return (
    <div className="fs-backdrop" onClick={onClose}>
      <div
        className="fs-dialog sig-viewer-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fs-head">
          <div className="fs-titles">
            <h2>{target.title}</h2>
            {target.subtitle && <p>{target.subtitle}</p>}
          </div>
          <button className="fs-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="fs-body sig-viewer-body">
          <div className="sig-viewer-col">
            <div className="sig-viewer-collabel">
              {t("sig.viewerOriginal")}
            </div>
            <div className="sig-viewer-imgwrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={target.src}
                alt={target.title}
                className="sig-viewer-img"
                onLoad={recompute}
              />
              {box && (
                <div
                  className="sig-viewer-box"
                  style={{
                    left: `${box.left}px`,
                    top: `${box.top}px`,
                    width: `${box.width}px`,
                    height: `${box.height}px`,
                  }}
                >
                  <span className="sig-viewer-box-tag">
                    {t("sig.embeddedRegionTag")}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* The EXACT embedded region, cropped via CSS background — so you can
              verify what the vector actually represents. */}
          {c && c.w > 0.005 && c.h > 0.005 && (
            <div className="sig-viewer-col">
              <div className="sig-viewer-collabel">
                {t("sig.viewerEmbedded")}
              </div>
              <div
                className="sig-viewer-cropview"
                style={{
                  aspectRatio: `${c.w} / ${c.h}`,
                  backgroundImage: `url(${target.src})`,
                  backgroundSize: `${100 / c.w}% ${100 / c.h}%`,
                  backgroundPosition: `${(c.x / (1 - c.w || 1)) * 100}% ${
                    (c.y / (1 - c.h || 1)) * 100
                  }%`,
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Info tooltip explaining the detect→box→embed mechanism as step cards. */
function InfoTip() {
  const { t } = useI18n();
  const steps = [1, 2, 3, 4].map((n) => ({
    title: t(`sig.step${n}.title`),
    body: t(`sig.step${n}.body`),
  }));
  return (
    <span className="info-tip" tabIndex={0}>
      <span className="info-tip-icon">i</span>
      <span className="info-tip-bubble">
        <span className="info-tip-title">{t("sig.mechanismTitle")}</span>
        {steps.map((s, i) => (
          <span className="info-step-card" key={i}>
            <span className="info-step-title">{s.title}</span>
            <span className="info-step-body">{s.body}</span>
          </span>
        ))}
       </span>
     </span>
   );
}

/**
 * Live progress shown while auto-detect runs. The API is non-streaming and the
 * vision call can take ~a minute, so we advance through the KNOWN phases on a
 * timer and show a running elapsed counter, so the wait isn't a blank spinner.
 */
function DetectProgress() {
  const { t } = useI18n();
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setMs(Date.now() - start), 200);
    return () => clearInterval(id);
  }, []);

  const phases = [
    { key: "sig.phase.prepare", at: 0 },
    { key: "sig.phase.upload", at: 400 },
    { key: "sig.phase.locate", at: 1500 },
    { key: "sig.phase.parse", at: null as number | null }, // reached on completion
  ];
  // Current phase = last phase whose threshold has passed (locate is the long one).
  let active = 0;
  for (let i = 0; i < phases.length; i++) {
    const at = phases[i].at;
    if (at != null && ms >= at) active = i;
  }

  return (
    <div className="sig-progress">
      <div className="sig-progress-head">
        <span className="loading" />
        <span className="sig-progress-title">{t("sig.detecting")}</span>
        <span className="sig-progress-time">
          {t("sig.elapsed", { s: (ms / 1000).toFixed(1) })}
        </span>
      </div>
      <div className="sig-progress-steps">
        {phases.map((p, i) => (
          <div
            key={p.key}
            className={`sig-progress-step ${
              i < active ? "done" : i === active ? "active" : "pending"
            }`}
          >
            <span className="sig-progress-dot" />
            {t(p.key)}
          </div>
        ))}
      </div>
      <div className="sig-progress-hint">{t("sig.detectingHint")}</div>
    </div>
  );
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DetectStep {
  step: string;
  status: "ok" | "warn" | "error";
  ms?: number;
  note?: string;
  stepKey?: string;
  noteKey?: string;
  vars?: Record<string, string | number>;
}
interface DetectResult {
  cropRect: Rect | null;
  /** All detected signature regions (may contain more than one). */
  cropRects?: Rect[];
  steps: DetectStep[];
  rawResponse?: string;
}

/** Popup showing the step-by-step auto-detect process. */
function ProcessDialog({
  result,
  onClose,
}: {
  result: DetectResult | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, onClose]);
  if (!result) return null;
  return (
    <div className="fs-backdrop" onClick={onClose}>
      <div
        className="fs-dialog sig-process-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fs-head">
          <div className="fs-titles">
            <h2>{t("sig.processTitle")}</h2>
            <p>{t("sig.processSub")}</p>
          </div>
          <button className="fs-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="fs-body sig-process-body">
          {result.steps.map((s, i) => (
            <div className={`sig-proc-step ${s.status}`} key={i}>
              <span className="sig-proc-dot" />
              <div className="sig-proc-main">
                <div className="sig-proc-step-title">
                  {s.stepKey ? t(s.stepKey) : s.step}
                  {typeof s.ms === "number" && (
                    <span className="sig-proc-ms">{s.ms} ms</span>
                  )}
                </div>
                {(s.noteKey || s.note) && (
                  <div className="sig-proc-note">
                    {s.noteKey ? t(s.noteKey, s.vars) : s.note}
                  </div>
                )}
              </div>
            </div>
          ))}
          {result.rawResponse && (
            <div className="sig-proc-raw">
              <div className="sig-proc-raw-label">{t("sig.rawResponse")}</div>
              <pre>{result.rawResponse}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One enrolled-specimen match row (thumbnail + name + score + band tag). */
function MatchRow({
  m,
  onView,
  t,
}: {
  m: MatchItem;
  onView: (v: ViewerTarget) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className={`sig-match band-${m.band}`}>
      {m.originalFileId && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="sig-match-thumb clickable"
          src={`/api/signatures/${m.signatureId}/file`}
          alt={m.signerName}
          title={t("sig.clickEnlarge")}
          onClick={() =>
            onView({
              src: `/api/signatures/${m.signatureId}/file`,
              title: m.signerName,
              subtitle: m.label,
              cropRect: m.cropRect,
            })
          }
        />
      )}
      <div className="sig-match-info">
        <div className="sig-match-name">{m.signerName}</div>
        {m.label && <div className="sig-match-label">{m.label}</div>}
        <div className="sig-match-score">
          {(m.similarity * 100).toFixed(1)}% {t("sig.similarity")}
        </div>
      </div>
      <span className={`sig-band-tag ${m.band}`}>{t(`sig.band.${m.band}`)}</span>
    </div>
  );
}

/**
 * File dropzone + a drag-to-select crop box over the preview. Reports the
 * normalized crop rect (0..1) up, so only the signature region is embedded.
 */
function SignatureCropper({
  file,
  onPick,
  crop,
  onCrop,
  onManualEdit,
  label,
}: {
  file: File | null;
  onPick: (f: File | null) => void;
  crop: Rect | null;
  onCrop: (r: Rect | null) => void;
  /** Fired when the user drags to draw/adjust the box (not auto-detect). */
  onManualEdit?: () => void;
  label: string;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      setNatural(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  function posInImg(e: React.MouseEvent): { x: number; y: number } | null {
    // Measure against the actual <img> box (not the wrapper), so letterboxing /
    // object-fit padding can never offset the normalized coordinates.
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1),
      y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1),
    };
  }

  // No image yet → plain dropzone.
  if (!url) {
    return (
      <div
        className={`dropzone sig-dropzone ${drag ? "drag" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onPick(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          hidden
          accept="image/*"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
        <div>
          <b>{label}</b>
          <div className="types">PNG / JPG / WEBP</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="sig-crop-hint">{t("sig.cropHint")}</div>
      <div
        ref={imgWrapRef}
        className="sig-crop-wrap"
        onMouseDown={(e) => {
          const p = posInImg(e);
          if (!p) return;
          dragStart.current = p;
          onManualEdit?.();
          onCrop({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onMouseMove={(e) => {
          if (!dragStart.current) return;
          const p = posInImg(e);
          if (!p) return;
          const s = dragStart.current;
          onCrop({
            x: Math.min(s.x, p.x),
            y: Math.min(s.y, p.y),
            w: Math.abs(p.x - s.x),
            h: Math.abs(p.y - s.y),
          });
        }}
        onMouseUp={() => {
          dragStart.current = null;
        }}
        onMouseLeave={() => {
          dragStart.current = null;
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={url}
          alt="signature"
          className="sig-crop-img"
          draggable={false}
          onLoad={(e) => {
            const im = e.currentTarget;
            setNatural({ w: im.naturalWidth, h: im.naturalHeight });
          }}
        />
        {crop && crop.w > 0.005 && crop.h > 0.005 && (
          <div
            className="sig-crop-box"
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.w * 100}%`,
              height: `${crop.h * 100}%`,
            }}
          />
        )}
      </div>
      <div className="sig-crop-actions">
        <button
          className="btn sm"
          onClick={() => inputRef.current?.click()}
        >
          ↺
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept="image/*"
          onChange={(e) => {
            onCrop(null);
            onPick(e.target.files?.[0] ?? null);
          }}
        />
        {crop && (
          <button className="btn sm" onClick={() => onCrop(null)}>
            {t("sig.clearCrop")}
          </button>
        )}
      </div>

      {/* Live preview of EXACTLY the region that will be embedded. Its box keeps
          the true aspect ratio of the cropped region (not the panel width). */}
      {crop && crop.w > 0.005 && crop.h > 0.005 && url && (
        <div className="sig-cropped-preview">
          <div className="sig-cropped-label">{t("sig.embeddedRegion")}</div>
          <div
            className="sig-cropped-view"
            style={{
              aspectRatio: natural
                ? `${crop.w * natural.w} / ${crop.h * natural.h}`
                : `${crop.w} / ${crop.h}`,
              backgroundImage: `url(${url})`,
              backgroundSize: `${100 / crop.w}% ${100 / crop.h}%`,
              backgroundPosition: `${(crop.x / (1 - crop.w || 1)) * 100}% ${
                (crop.y / (1 - crop.h || 1)) * 100
              }%`,
            }}
          />
        </div>
      )}
    </div>
  );
}

export function SignaturesTab() {
  const { t } = useI18n();
  const [items, setItems] = useState<SignatureItem[]>([]);
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(
    null
  );

  // Enrol form
  const [enrollFile, setEnrollFile] = useState<File | null>(null);
  const [enrollCrop, setEnrollCrop] = useState<Rect | null>(null);
  const [signerName, setSignerName] = useState("");
  const [label, setLabel] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [detectingEnroll, setDetectingEnroll] = useState(false);
  const [enrollProcess, setEnrollProcess] = useState<DetectResult | null>(null);
  // All signature regions detected in the enrol image. When >1, EACH region is
  // enrolled as its own specimen with its own name/label (tenant, landlord, …).
  const [enrollBoxes, setEnrollBoxes] = useState<Rect[]>([]);
  // Per-region signer names/labels, keyed by region index (multi-region enrol).
  const [regionNames, setRegionNames] = useState<Record<number, string>>({});
  const [regionLabels, setRegionLabels] = useState<Record<number, string>>({});

  // Compare
  const [queryFile, setQueryFile] = useState<File | null>(null);
  const [queryCrop, setQueryCrop] = useState<Rect | null>(null);
  const [detectingQuery, setDetectingQuery] = useState(false);
  const [queryProcess, setQueryProcess] = useState<DetectResult | null>(null);
  // All signature regions detected in the query image (>1 = user chooses one).
  const [queryBoxes, setQueryBoxes] = useState<Rect[]>([]);
  const [comparing, setComparing] = useState(false);
  // Which detect trace to show in the process dialog.
  const [processDialog, setProcessDialog] = useState<DetectResult | null>(null);
  const [matches, setMatches] = useState<MatchItem[] | null>(null);
  // Per-region compare results (best match per detected signature region).
  const [regionResults, setRegionResults] = useState<RegionResult[] | null>(
    null
  );
  const [thresholds, setThresholds] = useState<{
    match: number;
    review: number;
  } | null>(null);

  // Enlarged signature viewer (full image + boxed embedded region).
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/signatures");
      const data = await res.json();
      setItems(data.signatures ?? []);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function autoDetect(
    file: File | null,
    setCrop: (r: Rect | null) => void,
    setBusy: (b: boolean) => void,
    setProcess: (r: DetectResult | null) => void,
    setBoxes?: (r: Rect[]) => void
  ) {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    setProcess(null);
    setBoxes?.([]);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/signatures/detect", {
        method: "POST",
        body: fd,
      });
      const data: DetectResult & { error?: string } = await res.json();
      if (data.error) {
        setNotice({ kind: "warn", text: data.error });
        return;
      }
      setProcess(data);
      // The API may return several signature regions. Keep them all so the user
      // can pick which one to enrol/compare; default the active crop to the first.
      const boxes = data.cropRects ?? (data.cropRect ? [data.cropRect] : []);
      setBoxes?.(boxes);
      if (boxes.length > 0) {
        setCrop(boxes[0]);
        if (boxes.length > 1) {
          setNotice({
            kind: "info",
            text: t("sig.multiRegion", { count: boxes.length }),
          });
        }
      } else {
        setNotice({ kind: "warn", text: t("sig.noRegion") });
      }
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    if (!enrollFile) {
      setNotice({ kind: "warn", text: t("sig.needFileAndName") });
      return;
    }
    const multi = enrollBoxes.length > 1;

    setEnrolling(true);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", enrollFile);

      if (multi) {
        // Enrol EACH named region as its own specimen. Regions left unnamed are
        // skipped by the server, so the user can enrol just the ones they care
        // about (e.g. only the tenant + landlord signatures).
        const regions = enrollBoxes
          .map((box, i) => ({
            signerName: (regionNames[i] || "").trim(),
            label: (regionLabels[i] || "").trim() || undefined,
            cropRect: box,
          }))
          .filter((r) => r.signerName);
        if (regions.length === 0) {
          setNotice({ kind: "warn", text: t("sig.needRegionNames") });
          setEnrolling(false);
          return;
        }
        fd.append("regions", JSON.stringify(regions));
      } else {
        if (!signerName.trim()) {
          setNotice({ kind: "warn", text: t("sig.needFileAndName") });
          setEnrolling(false);
          return;
        }
        fd.append("signerName", signerName.trim());
        if (label.trim()) fd.append("label", label.trim());
        if (enrollCrop) fd.append("cropRect", JSON.stringify(enrollCrop));
      }

      const res = await fetch("/api/signatures", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) {
        setNotice({ kind: "warn", text: data.error });
      } else {
        const count = data.signatures?.length ?? (data.signature ? 1 : 0);
        setNotice({
          kind: "info",
          text:
            count > 1
              ? t("sig.enrolledMany", { count })
              : t("sig.enrolled", {
                  name:
                    data.signature?.signerName ??
                    data.signatures?.[0]?.signerName ??
                    "",
                }),
        });
        setEnrollFile(null);
        setEnrollCrop(null);
        setEnrollBoxes([]);
        setRegionNames({});
        setRegionLabels({});
        setSignerName("");
        setLabel("");
        await load();
      }
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    } finally {
      setEnrolling(false);
    }
  }

  async function remove(signatureId: string) {
    if (!window.confirm(t("sig.deleteConfirm"))) return;
    await fetch(`/api/signatures/${signatureId}`, { method: "DELETE" });
    await load();
  }

  /**
   * Compare ALL detected signature regions of the query document at once and
   * show the best match PER region. The user does NOT pick a region — vector
   * search finds the best-matching enrolled specimen for each region on its own.
   */
  async function runCompare() {
    if (!queryFile) return;
    if (!items.length) {
      setNotice({ kind: "warn", text: t("sig.noEnrolled") });
      return;
    }
    // Prefer the auto-detected regions; fall back to a single active box, then
    // to letting the server auto-detect if we somehow have neither.
    const boxes =
      queryBoxes.length > 0
        ? queryBoxes
        : queryCrop
        ? [queryCrop]
        : [];
    setComparing(true);
    setMatches(null);
    setRegionResults(null);
    try {
      const fd = new FormData();
      fd.append("file", queryFile);
      if (boxes.length > 0) fd.append("cropRects", JSON.stringify(boxes));
      const res = await fetch("/api/signatures/compare", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (data.error) {
        setNotice({ kind: "warn", text: data.error });
      } else {
        setRegionResults(data.regions ?? []);
        setMatches(data.matches ?? []);
        setThresholds(data.thresholds ?? null);
      }
    } catch (e) {
      setNotice({ kind: "warn", text: (e as Error).message });
    } finally {
      setComparing(false);
    }
  }

  return (
    <div>
      {notice && (
        <div className={`notice ${notice.kind}`} style={{ marginBottom: 12 }}>
          {notice.text}
        </div>
      )}

      <div className="sig-grid">
        {/* Enrol */}
        <div className="panel">
          <h2>{t("sig.enrollTitle")}</h2>
          <p className="sub">{t("sig.enrollSub")}</p>
          <SignatureCropper
            file={enrollFile}
            onPick={(f) => {
              setEnrollFile(f);
              setEnrollCrop(null);
              setEnrollBoxes([]);
              setRegionNames({});
              setRegionLabels({});
              if (f)
                autoDetect(
                  f,
                  setEnrollCrop,
                  setDetectingEnroll,
                  setEnrollProcess,
                  setEnrollBoxes
                );
            }}
            crop={enrollCrop}
            onCrop={setEnrollCrop}
            label={t("sig.dropSignature")}
          />
          {enrollFile && (
            <>
              <div className="sig-detect-row">
                <button
                  className="btn sm"
                  onClick={() =>
                    autoDetect(
                      enrollFile,
                      setEnrollCrop,
                      setDetectingEnroll,
                      setEnrollProcess,
                      setEnrollBoxes
                    )
                  }
                  disabled={detectingEnroll}
                >
                  {detectingEnroll ? (
                    <>
                      <span className="loading" /> {t("sig.detecting")}
                    </>
                  ) : (
                    t("sig.autoDetect")
                  )}
                </button>
                {enrollProcess && !detectingEnroll && (
                  <button
                    className="btn sm"
                    onClick={() => setProcessDialog(enrollProcess)}
                  >
                    {t("sig.viewProcess")}
                  </button>
                )}
                <span className="sig-crop-status">
                  {enrollCrop ? t("sig.cropped") : t("sig.wholeImageWarn")}
                </span>
              </div>
              {detectingEnroll && <DetectProgress />}
            </>
          )}

          {enrollBoxes.length > 1 ? (
            // MULTI-region: name each detected signature; each becomes its own
            // specimen. Leave a name blank to skip that region.
            <div className="sig-region-enroll" style={{ marginTop: 10 }}>
              <div className="sig-region-enroll-hint">
                {t("sig.multiEnrollHint", { count: enrollBoxes.length })}
              </div>
              {enrollBoxes.map((box, i) => (
                <div
                  className="sig-region-enroll-row"
                  key={i}
                  onMouseEnter={() => setEnrollCrop(box)}
                  style={{
                    border: "1px solid var(--border, #ddd)",
                    borderRadius: 8,
                    padding: 10,
                    marginTop: 8,
                  }}
                >
                  <div
                    className="sig-region-enroll-title"
                    style={{ fontWeight: 600, marginBottom: 6 }}
                  >
                    {t("sig.regionN", { n: i + 1 })}
                  </div>
                  <div className="field">
                    <label>{t("sig.signerName")}</label>
                    <input
                      value={regionNames[i] || ""}
                      onChange={(e) =>
                        setRegionNames((m) => ({ ...m, [i]: e.target.value }))
                      }
                      placeholder={t("sig.signerPlaceholder")}
                    />
                  </div>
                  <div className="field">
                    <label>{t("sig.label")}</label>
                    <input
                      value={regionLabels[i] || ""}
                      onChange={(e) =>
                        setRegionLabels((m) => ({ ...m, [i]: e.target.value }))
                      }
                      placeholder={t("sig.labelPlaceholder")}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="field" style={{ marginTop: 10 }}>
                <label>{t("sig.signerName")}</label>
                <input
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder={t("sig.signerPlaceholder")}
                />
              </div>
              <div className="field">
                <label>{t("sig.label")}</label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("sig.labelPlaceholder")}
                />
              </div>
            </>
          )}
          <div className="sig-btn-row">
            <button
              className="btn primary"
              onClick={enroll}
              disabled={enrolling}
            >
              {enrolling ? (
                <>
                  <span className="loading" /> {t("sig.enrolling")}
                </>
              ) : enrollBoxes.length > 1 ? (
                t("sig.enrollAllBtn", { count: enrollBoxes.length })
              ) : (
                t("sig.enrollBtn")
              )}
            </button>
            <InfoTip />
          </div>

          {/* Enrolled library lives inside the Enrol panel so the left column
              fills with its own output instead of leaving empty space. */}
          <div className="sig-library-block">
            <h3 className="sig-library-title">
              {t("sig.libraryTitle", { n: items.length })}
            </h3>
            {!items.length && (
              <div className="empty">{t("sig.emptyLibrary")}</div>
            )}
            {!!items.length && (
              <div className="sig-library">
                {items.map((s) => (
                  <div className="sig-card" key={s.signatureId}>
                    {s.originalFileId && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className="sig-card-thumb clickable"
                        src={`/api/signatures/${s.signatureId}/file`}
                        alt={s.signerName}
                        title={t("sig.clickEnlarge")}
                        onClick={() =>
                          setViewer({
                            src: `/api/signatures/${s.signatureId}/file`,
                            title: s.signerName,
                            subtitle: s.label,
                            cropRect: s.cropRect,
                          })
                        }
                      />
                    )}
                    <div className="sig-card-name">{s.signerName}</div>
                    {s.label && (
                      <div className="sig-card-label">{s.label}</div>
                    )}
                    <button
                      className="btn sm danger sig-card-del"
                      onClick={() => remove(s.signatureId)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Compare */}
        <div className="panel">
          <h2>{t("sig.compareTitle")}</h2>
          <p className="sub">{t("sig.compareSub")}</p>
          <SignatureCropper
            file={queryFile}
            onPick={(f) => {
              setQueryFile(f);
              setQueryCrop(null);
              setQueryBoxes([]);
              setMatches(null);
              setRegionResults(null);
              if (f)
                autoDetect(
                  f,
                  setQueryCrop,
                  setDetectingQuery,
                  setQueryProcess,
                  setQueryBoxes
                );
            }}
            crop={queryCrop}
            onCrop={setQueryCrop}
            onManualEdit={() => {
              // Manual box change invalidates prior results.
              setMatches(null);
              setRegionResults(null);
            }}
            label={t("sig.dropQuery")}
          />
          {queryFile && (
            <>
              <div className="sig-detect-row">
                <button
                  className="btn sm"
                  onClick={() =>
                    autoDetect(
                      queryFile,
                      setQueryCrop,
                      setDetectingQuery,
                      setQueryProcess,
                      setQueryBoxes
                    )
                  }
                  disabled={detectingQuery}
                >
                  {detectingQuery ? (
                    <>
                      <span className="loading" /> {t("sig.detecting")}
                    </>
                  ) : (
                    t("sig.autoDetect")
                  )}
                </button>
                {queryProcess && !detectingQuery && (
                  <button
                    className="btn sm"
                    onClick={() => setProcessDialog(queryProcess)}
                  >
                    {t("sig.viewProcess")}
                  </button>
                )}
                <span className="sig-crop-status">
                  {queryBoxes.length > 1
                    ? t("sig.nRegions", { count: queryBoxes.length })
                    : queryCrop
                    ? t("sig.cropped")
                    : t("sig.wholeImageWarn")}
                </span>
              </div>
              {detectingQuery && <DetectProgress />}
              {!detectingQuery && queryBoxes.length > 1 && (
                <div className="sig-detect-hint">
                  {t("sig.compareAllHint", { count: queryBoxes.length })}
                </div>
              )}
              {!detectingQuery && queryBoxes.length <= 1 && (
                <div className="sig-detect-hint">
                  {t("sig.autoDetectUnreliableHint")}
                </div>
              )}
            </>
          )}
          <div className="sig-btn-row">
            <button
              className="btn primary"
              onClick={runCompare}
              disabled={comparing || !queryFile}
            >
              {comparing ? (
                <>
                  <span className="loading" /> {t("sig.comparing")}
                </>
              ) : (
                t("sig.compareBtn")
              )}
            </button>
            <InfoTip />
          </div>

          {(regionResults || matches) && (
            <div className="sig-results">
              <div className="sources-title" style={{ marginTop: 14 }}>
                {t("sig.results")}
              </div>
              {thresholds && (
                <div className="sig-thresholds">
                  {t("sig.thresholds", {
                    match: thresholds.match,
                    review: thresholds.review,
                  })}
                </div>
              )}

              {/* Per-region results: one group per detected signature region,
                  each showing its best-matching enrolled specimen. */}
              {regionResults && regionResults.length > 0
                ? regionResults.map((rr) => (
                    <div className="sig-region-result" key={rr.regionIndex}>
                      <div
                        className="sig-region-result-head"
                        style={{
                          fontWeight: 600,
                          marginTop: 12,
                          marginBottom: 4,
                        }}
                      >
                        {t("sig.regionResultHead", {
                          n: rr.regionIndex,
                        })}
                      </div>
                      {!rr.best && (
                        <div className="empty">{t("common.noResults")}</div>
                      )}
                      {rr.best && (
                        <MatchRow m={rr.best} onView={setViewer} t={t} />
                      )}
                    </div>
                  ))
                : (matches ?? []).map((m) => (
                    <MatchRow
                      key={m.signatureId}
                      m={m}
                      onView={setViewer}
                      t={t}
                    />
                  ))}

              {regionResults && regionResults.length === 0 && (
                <div className="empty">{t("common.noResults")}</div>
              )}
            </div>
          )}
        </div>
      </div>

      <SignatureViewer target={viewer} onClose={() => setViewer(null)} />
      <ProcessDialog
        result={processDialog}
        onClose={() => setProcessDialog(null)}
      />
    </div>
  );
}
