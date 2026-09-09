"use client";

// ===========================================================================
// Multi-dataset isolation — client state.
//
// Holds the active demo dataset (persisted to localStorage) and the list of
// available datasets. All API calls read the active datasetId and send it so
// retrieval + uploads are scoped to one demo. Creating a "New demo" here makes
// it active immediately, so everything uploaded next lands in that demo.
// ===========================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export interface Dataset {
  datasetId: string;
  name: string;
  description?: string;
  builtin?: boolean;
  documentCount?: number;
  chunkCount?: number;
}

interface DatasetContextValue {
  datasets: Dataset[];
  activeId: string;
  active: Dataset | null;
  loading: boolean;
  setActiveId: (id: string) => void;
  refresh: () => Promise<void>;
  createDataset: (name: string, description?: string) => Promise<Dataset | null>;
  deleteDataset: (id: string) => Promise<boolean>;
}

const DatasetContext = createContext<DatasetContextValue | null>(null);

const STORAGE_KEY = "activeDatasetId";
const DEFAULT_ID = "property";

export function DatasetProvider({ children }: { children: React.ReactNode }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeId, setActiveIdState] = useState<string>(DEFAULT_ID);
  const [loading, setLoading] = useState(true);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/datasets");
      const data = await res.json();
      setDatasets(data.datasets ?? []);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
    if (saved) setActiveIdState(saved);
    refresh();
  }, [refresh]);

  const createDataset = useCallback(
    async (name: string, description?: string): Promise<Dataset | null> => {
      const res = await fetch("/api/datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const data = await res.json();
      if (data.error || !data.dataset) return null;
      await refresh();
      setActiveId(data.dataset.datasetId);
      return data.dataset as Dataset;
    },
    [refresh, setActiveId]
  );

  const deleteDataset = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await fetch(`/api/datasets/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return false;
      // If we deleted the active dataset, fall back to the default.
      if (id === activeId) setActiveId(DEFAULT_ID);
      await refresh();
      return true;
    },
    [activeId, refresh, setActiveId]
  );

  const active = datasets.find((d) => d.datasetId === activeId) ?? null;

  return (
    <DatasetContext.Provider
      value={{
        datasets,
        activeId,
        active,
        loading,
        setActiveId,
        refresh,
        createDataset,
        deleteDataset,
      }}
    >
      {children}
    </DatasetContext.Provider>
  );
}

export function useDataset(): DatasetContextValue {
  const ctx = useContext(DatasetContext);
  if (!ctx) {
    return {
      datasets: [],
      activeId: DEFAULT_ID,
      active: null,
      loading: false,
      setActiveId: () => {},
      refresh: async () => {},
      createDataset: async () => null,
      deleteDataset: async () => false,
    };
  }
  return ctx;
}
