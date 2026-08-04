"use client";

// ===========================================================================
// FSI EXPANSION — Global industry-mode context (client state).
//
// Holds the active dataset mode ("property" | "fsi"), persisted to
// localStorage so it survives reloads. All API calls read the current mode and
// send it as `metadataType`, and the header/chrome reads presentational config
// from industry.ts. Switching is instant — no server restart.
// ===========================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  IndustryMode,
  DEFAULT_MODE,
  coerceMode,
  INDUSTRY_CONFIG,
} from "./industry";
import { useI18n } from "./i18n";

interface IndustryContextValue {
  mode: IndustryMode;
  setMode: (m: IndustryMode) => void;
  /** Presentational config resolved for the current mode + language. */
  chrome: ReturnType<typeof useIndustryChrome>;
}

const IndustryContext = createContext<IndustryContextValue | null>(null);

const STORAGE_KEY = "industryMode";

export function IndustryProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<IndustryMode>(DEFAULT_MODE);

  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
    setModeState(coerceMode(saved));
  }, []);

  const setMode = useCallback((m: IndustryMode) => {
    setModeState(m);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, m);
    }
  }, []);

  const chrome = useIndustryChrome(mode);

  return (
    <IndustryContext.Provider value={{ mode, setMode, chrome }}>
      {children}
    </IndustryContext.Provider>
  );
}

/** Resolve title/tagline/placeholder for a mode using the active language. */
function useIndustryChrome(mode: IndustryMode) {
  const { lang } = useI18n();
  const l = lang === "zh" ? "zh" : "en";
  return INDUSTRY_CONFIG[mode][l];
}

export function useIndustry(): IndustryContextValue {
  const ctx = useContext(IndustryContext);
  if (!ctx) {
    // Safe fallback (tests / outside provider): default property mode, EN.
    return {
      mode: DEFAULT_MODE,
      setMode: () => {},
      chrome: INDUSTRY_CONFIG[DEFAULT_MODE].en,
    };
  }
  return ctx;
}
