"use client";

import { fmtClock } from "@/lib/bops/client";

export interface ChartSignal {
  key: string;
  label: string;
  unit: string;
  color: string;
}

interface Props {
  points: any[]; // raw: {ts, <key>} ; agg: {ts, <key>_avg,_min,_max}
  signal: ChartSignal;
  mode: "raw" | "agg";
  height?: number;
  /** Optional horizontal reference line (e.g. baseline) with a label. */
  refLine?: { value: number; label: string };
  /** Optional ISO time to mark (e.g. detection time). */
  markTime?: string;
}

// Lightweight dependency-free SVG line chart. Renders a single signal so each
// series keeps its own y-scale and unit (no summing unlike units).
export function TelemetryChart({
  points,
  signal,
  mode,
  height = 150,
  refLine,
  markTime,
}: Props) {
  const W = 680;
  const H = height;
  const padL = 46;
  const padR = 12;
  const padT = 12;
  const padB = 22;

  const valKey = mode === "agg" ? `${signal.key}_avg` : signal.key;
  const rows = points
    .map((p) => ({
      t: new Date(p.ts).getTime(),
      v: typeof p[valKey] === "number" ? p[valKey] : null,
      min: typeof p[`${signal.key}_min`] === "number" ? p[`${signal.key}_min`] : null,
      max: typeof p[`${signal.key}_max`] === "number" ? p[`${signal.key}_max`] : null,
    }))
    .filter((r) => r.v != null) as { t: number; v: number; min: number | null; max: number | null }[];

  if (!rows.length) {
    return (
      <div className="bops-chart-empty" role="img" aria-label={`${signal.label}: no data`}>
        No data in range
      </div>
    );
  }

  const tMin = rows[0].t;
  const tMax = rows[rows.length - 1].t || tMin + 1;
  const allV = rows.flatMap((r) => [r.v, r.min ?? r.v, r.max ?? r.v]);
  if (refLine) allV.push(refLine.value);
  let vMin = Math.min(...allV);
  let vMax = Math.max(...allV);
  if (vMin === vMax) {
    vMin -= 1;
    vMax += 1;
  }
  const vPad = (vMax - vMin) * 0.1;
  vMin -= vPad;
  vMax += vPad;

  const x = (t: number) =>
    padL + ((t - tMin) / (tMax - tMin || 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - vMin) / (vMax - vMin)) * (H - padT - padB);

  const linePath = rows.map((r, i) => `${i ? "L" : "M"}${x(r.t).toFixed(1)},${y(r.v).toFixed(1)}`).join(" ");

  // min/max band (agg mode only)
  const bandPath =
    mode === "agg" && rows.every((r) => r.min != null && r.max != null)
      ? `M${rows.map((r) => `${x(r.t).toFixed(1)},${y(r.max!).toFixed(1)}`).join(" L")} L${[...rows]
          .reverse()
          .map((r) => `${x(r.t).toFixed(1)},${y(r.min!).toFixed(1)}`)
          .join(" L")} Z`
      : null;

  const ticks = [vMin, (vMin + vMax) / 2, vMax];
  const latest = rows[rows.length - 1];

  return (
    <figure className="bops-chart" aria-label={`${signal.label} in ${signal.unit}, ${mode} mode`}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
        {/* y gridlines + labels */}
        {ticks.map((tv, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(tv)}
              y2={y(tv)}
              stroke="var(--border-soft)"
              strokeWidth={1}
            />
            <text x={4} y={y(tv) + 4} fontSize={10} fill="var(--text-faint)">
              {tv.toFixed(1)}
            </text>
          </g>
        ))}
        {/* reference line */}
        {refLine && (
          <g>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(refLine.value)}
              y2={y(refLine.value)}
              stroke="var(--amber)"
              strokeDasharray="4 3"
              strokeWidth={1}
            />
            <text x={W - padR} y={y(refLine.value) - 3} fontSize={9} fill="var(--amber)" textAnchor="end">
              {refLine.label}
            </text>
          </g>
        )}
        {/* detection marker */}
        {markTime &&
          (() => {
            const mt = new Date(markTime).getTime();
            if (mt < tMin || mt > tMax) return null;
            return (
              <line
                x1={x(mt)}
                x2={x(mt)}
                y1={padT}
                y2={H - padB}
                stroke="var(--red)"
                strokeWidth={1.5}
                strokeDasharray="3 2"
              />
            );
          })()}
        {bandPath && <path d={bandPath} fill={signal.color} opacity={0.14} />}
        <path d={linePath} fill="none" stroke={signal.color} strokeWidth={1.8} />
        <circle cx={x(latest.t)} cy={y(latest.v)} r={3} fill={signal.color} />
        {/* x end labels */}
        <text x={padL} y={H - 6} fontSize={9} fill="var(--text-faint)">
          {fmtClock(tMin)}
        </text>
        <text x={W - padR} y={H - 6} fontSize={9} fill="var(--text-faint)" textAnchor="end">
          {fmtClock(tMax)}
        </text>
      </svg>
      <figcaption className="bops-chart-cap">
        <span className="bops-chart-swatch" style={{ background: signal.color }} aria-hidden />
        {signal.label} ({signal.unit}) · latest{" "}
        <strong>{latest.v.toFixed(2)}</strong>
        {mode === "agg" ? " · 1-min avg with min/max band" : " · raw"}
      </figcaption>
    </figure>
  );
}
