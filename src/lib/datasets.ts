// ===========================================================================
// Multi-dataset isolation.
//
// A "dataset" is an isolated namespace of documents + chunks for one demo. All
// uploads and retrieval are scoped to the active dataset via the `datasetId`
// field, so a demo to one customer never surfaces another customer's docs.
//
// This generalises the earlier hard-coded property/fsi `metadataType` split:
//   - Built-in datasets "property" and "fsi" map onto legacy data.
//   - New datasets (e.g. "hld") can be created live from the UI.
//
// Backward compatibility: legacy documents seeded before datasets existed have
// no `datasetId`. They are treated as belonging to env.defaultDatasetId
// ("property"), and — for the "fsi" dataset — the old `metadataType` field is
// honoured too, so nothing needs re-seeding.
// ===========================================================================

import {
  getDatasetsCollection,
  getDocumentsCollection,
  getCollection,
  DatasetDoc,
} from "./mongo";
import { env } from "./env";

/** The built-in datasets that always exist (map onto the original seed data). */
export const BUILTIN_DATASETS: { datasetId: string; name: string; description: string }[] =
  [
    {
      datasetId: "property",
      name: "Property Management",
      description: "Original property-operations corpus (SOPs, incidents, rosters).",
    },
    {
      datasetId: "fsi",
      name: "FSI Address Verification",
      description: "FSI Funding Reach address-verification corpus (geo + floor).",
    },
  ];

export function slugifyDatasetId(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "demo"
  );
}

/**
 * Build the MongoDB filter that isolates a dataset. Handles legacy data:
 *   - "property"  -> datasetId "property" OR missing (legacy, incl. old
 *                    metadataType != "fsi").
 *   - "fsi"       -> datasetId "fsi" OR legacy metadataType == "fsi".
 *   - anything else (new demos) -> exact datasetId match only.
 *
 * IMPORTANT: the default dataset owns ONLY its own docs plus legacy/untagged
 * docs (datasetId missing). It must NOT match documents that carry a DIFFERENT
 * explicit datasetId (e.g. "hld-demo") — otherwise other demos leak into the
 * default demo's search results.
 *
 * `{ $in: [id, null] }` is Atlas-$vectorSearch-safe: inside a vector filter,
 * `null` in `$in` matches documents where the field is missing.
 */
export function datasetFilter(datasetId: string): Record<string, unknown> {
  // NOTE: Atlas $vectorSearch filters reject `null` inside `$in`/`$eq`. All data
  // is backfilled to carry an explicit datasetId (legacy → "property"), so we
  // use plain equality everywhere and never reference null here.
  if (datasetId === "fsi") {
    // Legacy fsi data may carry metadataType instead of datasetId.
    return { $or: [{ datasetId: "fsi" }, { metadataType: "fsi" }] };
  }
  // Default and all new demos: exact datasetId match only.
  return { datasetId };
}

/**
 * In-app equivalent of datasetFilter, used as a safety net when the Atlas index
 * hasn't registered `datasetId` as a filter field yet (server-side filter is
 * rejected → we retry unfiltered → we MUST re-apply isolation in application
 * code, or datasets leak into each other). Mirrors datasetFilter's semantics.
 */
export function matchesDataset(
  doc: { datasetId?: string | null; metadataType?: string | null },
  datasetId: string
): boolean {
  const id = doc.datasetId ?? null;
  if (datasetId === "fsi") {
    return id === "fsi" || doc.metadataType === "fsi";
  }
  if (datasetId === env.defaultDatasetId) {
    // The default dataset owns its own docs plus any doc that somehow still
    // lacks a datasetId (defensive; all data is backfilled) — but never a
    // different explicit dataset, and never fsi.
    return (id === datasetId || id == null) && doc.metadataType !== "fsi";
  }
  return id === datasetId;
}

/** Ensure the built-in datasets exist. Idempotent; safe to call on every read. */
export async function ensureBuiltinDatasets(): Promise<void> {
  const col = await getDatasetsCollection();
  const now = new Date().toISOString();
  for (const d of BUILTIN_DATASETS) {
    await col.updateOne(
      { datasetId: d.datasetId },
      {
        $setOnInsert: {
          _id: d.datasetId as any,
          datasetId: d.datasetId,
          name: d.name,
          description: d.description,
          builtin: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    );
  }
}

/** List datasets with live document/chunk counts, built-ins first. */
export async function listDatasets(): Promise<DatasetDoc[]> {
  await ensureBuiltinDatasets();
  const col = await getDatasetsCollection();
  const datasets = await col.find({}).sort({ builtin: -1, createdAt: 1 }).toArray();

  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();
  await Promise.all(
    datasets.map(async (d) => {
      const filter = datasetFilter(d.datasetId);
      try {
        d.documentCount = await docsCol.countDocuments(filter as any);
        d.chunkCount = await chunksCol.countDocuments(filter as any);
      } catch {
        d.documentCount = 0;
        d.chunkCount = 0;
      }
    })
  );
  return datasets;
}

export async function getDataset(datasetId: string): Promise<DatasetDoc | null> {
  const col = await getDatasetsCollection();
  return col.findOne({ datasetId });
}

/** Create a new dataset. Returns the created record (or existing if id clashes). */
export async function createDataset(
  name: string,
  description?: string
): Promise<DatasetDoc> {
  const col = await getDatasetsCollection();
  const now = new Date().toISOString();
  let base = slugifyDatasetId(name);
  // Avoid colliding with built-ins / existing ids.
  let datasetId = base;
  let n = 2;
  while (await col.findOne({ datasetId })) {
    datasetId = `${base}-${n++}`;
  }
  const doc: DatasetDoc = {
    _id: datasetId as any,
    datasetId,
    name: name.trim() || datasetId,
    description: description?.trim(),
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
  await col.insertOne(doc as any);
  return doc;
}

export async function renameDataset(
  datasetId: string,
  name: string,
  description?: string
): Promise<void> {
  const col = await getDatasetsCollection();
  await col.updateOne(
    { datasetId },
    {
      $set: {
        name: name.trim(),
        ...(description !== undefined ? { description: description.trim() } : {}),
        updatedAt: new Date().toISOString(),
      },
    }
  );
}

/**
 * Delete a dataset and ALL of its documents + chunks. Built-in datasets cannot
 * be deleted. Returns counts of what was removed.
 */
export async function deleteDataset(
  datasetId: string
): Promise<{ documents: number; chunks: number }> {
  const ds = await getDataset(datasetId);
  if (ds?.builtin) {
    throw new Error(`Built-in dataset "${datasetId}" cannot be deleted.`);
  }
  const filter = datasetFilter(datasetId);
  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();

  // Best-effort: delete original files from GridFS for these documents.
  const docs = await docsCol.find(filter as any).project({ originalFileId: 1 }).toArray();
  const { deleteOriginalFile } = await import("./mongo");
  await Promise.all(docs.map((d: any) => deleteOriginalFile(d.originalFileId)));

  const chunks = await chunksCol.deleteMany(filter as any);
  const documents = await docsCol.deleteMany(filter as any);
  const col = await getDatasetsCollection();
  await col.deleteOne({ datasetId });
  return {
    documents: documents.deletedCount ?? 0,
    chunks: chunks.deletedCount ?? 0,
  };
}

/** Coerce an arbitrary dataset id to a safe value (falls back to default). */
export function coerceDatasetId(v: unknown): string {
  if (typeof v === "string" && v.trim()) return v.trim();
  return env.defaultDatasetId;
}
