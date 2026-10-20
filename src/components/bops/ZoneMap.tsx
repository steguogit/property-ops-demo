"use client";

// Lightweight CSS/SVG zone schematic for the seeded building. Shows the three
// zones and places asset dots; highlights zones with an active incident.
interface AssetDot {
  assetId: string;
  type: string;
  zoneId: string;
  hasIncident: boolean;
  reporting: boolean;
  measurementsNormal?: boolean | null;
}

const ZONE_LAYOUT: Record<string, { x: number; y: number; w: number; h: number; label: string }> = {
  "ZONE-B2-PLANT": { x: 10, y: 120, w: 300, h: 70, label: "B2 Central Plant Room" },
  "ZONE-L10-AHU": { x: 10, y: 10, w: 180, h: 60, label: "L10 AHU Room" },
  "ZONE-GF-LOBBY": { x: 210, y: 10, w: 100, h: 60, label: "GF Lobby" },
};

const TYPE_GLYPH: Record<string, string> = {
  chiller: "❄",
  pump: "⟳",
  ahu: "≋",
  door_contact: "▢",
  access_panel: "⊡",
};

export function ZoneMap({
  assets,
  selectedAssetId,
  onSelect,
}: {
  assets: AssetDot[];
  selectedAssetId?: string | null;
  onSelect?: (assetId: string) => void;
}) {
  // position assets within their zone (simple horizontal spread)
  const byZone: Record<string, AssetDot[]> = {};
  for (const a of assets) (byZone[a.zoneId] ||= []).push(a);

  return (
    <svg viewBox="0 0 320 200" width="100%" height={200} role="img" aria-label="Building zone schematic" className="bops-zonemap">
      {Object.entries(ZONE_LAYOUT).map(([zoneId, z]) => {
        const zoneAssets = byZone[zoneId] ?? [];
        const incident = zoneAssets.some((a) => a.hasIncident);
        return (
          <g key={zoneId}>
            <rect
              x={z.x}
              y={z.y}
              width={z.w}
              height={z.h}
              rx={6}
              fill={incident ? "rgba(255,107,107,0.08)" : "var(--panel-2)"}
              stroke={incident ? "var(--red)" : "var(--border)"}
              strokeWidth={incident ? 1.5 : 1}
            />
            <text x={z.x + 8} y={z.y + 16} fontSize={9} fill="var(--text-dim)">
              {z.label}
            </text>
            {zoneAssets.map((a, i) => {
              const cx = z.x + 24 + i * 40;
              const cy = z.y + z.h - 20;
              const sel = a.assetId === selectedAssetId;
              return (
                <g
                  key={a.assetId}
                  onClick={() => onSelect?.(a.assetId)}
                  style={{ cursor: onSelect ? "pointer" : "default" }}
                  tabIndex={onSelect ? 0 : undefined}
                  role={onSelect ? "button" : undefined}
                  aria-label={`${a.assetId}${a.hasIncident ? ", incident" : ""}`}
                  onKeyDown={(e) => {
                    if (onSelect && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onSelect(a.assetId);
                    }
                  }}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={12}
                    fill={
                      a.hasIncident
                        ? a.measurementsNormal
                          ? "var(--amber)"
                          : "var(--red)"
                        : a.reporting
                        ? "var(--green-dim)"
                        : "var(--text-faint)"
                    }
                    stroke={sel ? "var(--blue)" : "transparent"}
                    strokeWidth={2}
                  />
                  <text x={cx} y={cy + 4} fontSize={11} textAnchor="middle" fill="#06281a">
                    {TYPE_GLYPH[a.type] ?? "●"}
                  </text>
                  <text x={cx} y={cy + 22} fontSize={7} textAnchor="middle" fill="var(--text-faint)">
                    {a.assetId}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
