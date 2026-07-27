import {
  getDocumentsCollection,
  getVersionsCollection,
  getCollection,
  DocumentVersionGroup,
} from "./mongo";

// ---------------------------------------------------------------------------
// Document versioning + lifecycle.
//
//  - Documents that are revisions of the same thing share a versionGroupId.
//  - The newest (by effectiveFrom) is the "current" version; older ones can be
//    marked obsolete/superseded.
//  - Retrieval prefers the current version by default but older versions stay
//    searchable when explicitly requested (includeObsolete).
//  - Partial-continuity is supported via a `note` per version, e.g. "floor
//    layout changed 6F->8F but 消防/fire layout unchanged from v2016".
//
// We keep this metadata-driven and explainable — no spatial reasoning.
// ---------------------------------------------------------------------------

/** Link two+ documents as versions of the same logical document. */
export async function linkVersions(
  versionGroupId: string,
  title: string,
  members: {
    documentId: string;
    versionLabel: string;
    effectiveFrom?: string;
    note?: string;
  }[],
  propertyName?: string
): Promise<DocumentVersionGroup> {
  const versionsCol = await getVersionsCollection();
  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();

  // Newest = max effectiveFrom (fall back to insertion order).
  const sorted = [...members].sort((a, b) =>
    (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? "")
  );
  const current = sorted[0];

  const group: DocumentVersionGroup = {
    _id: versionGroupId,
    versionGroupId,
    title,
    propertyName,
    currentDocumentId: current?.documentId,
    versions: sorted.map((m) => ({
      documentId: m.documentId,
      versionLabel: m.versionLabel,
      effectiveFrom: m.effectiveFrom,
      obsolete: m.documentId !== current?.documentId,
      note: m.note,
    })),
    updatedAt: new Date().toISOString(),
  };

  await versionsCol.replaceOne({ versionGroupId }, group as any, {
    upsert: true,
  });

  // Propagate version metadata + obsolete flags onto documents and chunks.
  for (const v of group.versions) {
    const obsolete = v.obsolete;
    await docsCol.updateOne(
      { documentId: v.documentId },
      {
        $set: {
          versionGroupId,
          versionLabel: v.versionLabel,
          obsoleteFlag: obsolete,
          supersededBy: obsolete ? current?.documentId : undefined,
          effectiveFrom: v.effectiveFrom,
          updatedAt: new Date().toISOString(),
        },
      }
    );
    await chunksCol.updateMany(
      { documentId: v.documentId },
      {
        $set: {
          versionGroupId,
          versionLabel: v.versionLabel,
          obsoleteFlag: obsolete,
          supersededBy: obsolete ? current?.documentId : undefined,
          effectiveFrom: v.effectiveFrom,
        },
      }
    );
  }

  return group;
}

/** Mark a single document obsolete (optionally pointing to its successor). */
export async function markObsolete(
  documentId: string,
  obsolete: boolean,
  supersededBy?: string
): Promise<void> {
  const docsCol = await getDocumentsCollection();
  const chunksCol = await getCollection();
  const patch = {
    obsoleteFlag: obsolete,
    supersededBy: obsolete ? supersededBy : undefined,
  };
  await docsCol.updateOne(
    { documentId },
    { $set: { ...patch, updatedAt: new Date().toISOString() } }
  );
  await chunksCol.updateMany({ documentId }, { $set: patch });
}

export async function listVersionGroups(): Promise<DocumentVersionGroup[]> {
  const col = await getVersionsCollection();
  return col.find({}).sort({ updatedAt: -1 }).toArray();
}

export async function getVersionGroup(
  versionGroupId: string
): Promise<DocumentVersionGroup | null> {
  const col = await getVersionsCollection();
  return col.findOne({ versionGroupId });
}

/**
 * Build a $vectorSearch / $search-compatible filter that excludes obsolete
 * chunks unless explicitly requested. Returns undefined when no filter needed.
 */
export function obsoleteFilter(
  includeObsolete: boolean
): Record<string, unknown> | undefined {
  if (includeObsolete) return undefined;
  // chunks may not carry the flag (legacy seed data) -> treat missing as false.
  return { obsoleteFlag: { $ne: true } };
}
