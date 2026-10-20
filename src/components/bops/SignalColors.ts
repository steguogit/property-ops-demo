// Shared signal → color/metadata map for charts and cards.
export const SIGNAL_META: Record<string, { label: string; unit: string; color: string }> = {
  leavingChilledWaterTempC: { label: "Leaving chilled-water temp", unit: "°C", color: "#4aa8ff" },
  compressorVibrationMmS: { label: "Compressor vibration", unit: "mm/s", color: "#b07bff" },
  electricalInputPowerKw: { label: "Electrical input power", unit: "kW", color: "#ffb454" },
  differentialPressureKpa: { label: "Differential pressure", unit: "kPa", color: "#00ed64" },
  flowRateLps: { label: "Flow rate", unit: "L/s", color: "#4aa8ff" },
  supplyAirTempC: { label: "Supply air temp", unit: "°C", color: "#4aa8ff" },
};

export const SEVERITY_META: Record<string, { label: string; color: string; icon: string }> = {
  critical: { label: "Critical", color: "var(--red)", icon: "⛔" },
  high: { label: "High", color: "var(--red)", icon: "▲" },
  medium: { label: "Medium", color: "var(--amber)", icon: "◆" },
  low: { label: "Low", color: "var(--blue)", icon: "•" },
  info: { label: "Info", color: "var(--text-dim)", icon: "ℹ" },
};
