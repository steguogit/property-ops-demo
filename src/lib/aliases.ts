import { getAliasesCollection, PropertyAliasDoc } from "./mongo";

// ---------------------------------------------------------------------------
// Property alias / naming consistency.
//
// The same property appears under different names across years and languages
// (EN / ZH / historical). The `property_aliases` collection holds the canonical
// identity + all known aliases. This module:
//   - resolves any name (incl. historical / ZH) to its canonical record
//   - expands a query with known aliases so retrieval benefits from them
//   - lets ingestion auto-tag an uploaded document with the right aliases
// ---------------------------------------------------------------------------

let cache: { docs: PropertyAliasDoc[]; ts: number } | null = null;
const TTL_MS = 60 * 1000;

export async function getAllAliases(): Promise<PropertyAliasDoc[]> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.docs;
  const col = await getAliasesCollection();
  const docs = await col.find({}).toArray();
  cache = { docs, ts: Date.now() };
  return docs;
}

export function invalidateAliasCache() {
  cache = null;
}

function allNamesFor(doc: PropertyAliasDoc): string[] {
  const names = new Set<string>();
  if (doc.canonicalName) names.add(doc.canonicalName);
  if (doc.officialChineseName) names.add(doc.officialChineseName);
  for (const a of doc.aliases ?? []) names.add(a);
  for (const h of doc.historicalNames ?? []) names.add(h.name);
  return [...names].filter(Boolean);
}

/** Resolve any name (EN/ZH/historical) to its canonical alias record. */
export async function resolveProperty(
  name: string
): Promise<PropertyAliasDoc | null> {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  const docs = await getAllAliases();
  for (const d of docs) {
    if (allNamesFor(d).some((n) => n.toLowerCase() === target)) return d;
  }
  // substring fallback (e.g. "YOHO" -> "YOHO Mall")
  for (const d of docs) {
    if (allNamesFor(d).some((n) => n.toLowerCase().includes(target))) return d;
  }
  return null;
}

/**
 * Given a free-text query, find which known property entities it mentions and
 * return the union of their aliases. Used to expand lexical search so a query
 * for "形點" also benefits from "YOHO Mall" and vice-versa.
 */
export async function aliasesForQuery(query: string): Promise<{
  matchedProperties: string[];
  expandedAliases: string[];
}> {
  const q = query.toLowerCase();
  const docs = await getAllAliases();
  const matchedProperties: string[] = [];
  const expanded = new Set<string>();
  for (const d of docs) {
    const names = allNamesFor(d);
    if (names.some((n) => n && q.includes(n.toLowerCase()))) {
      matchedProperties.push(d.canonicalName);
      names.forEach((n) => expanded.add(n));
    }
  }
  return { matchedProperties, expandedAliases: [...expanded] };
}

/** For ingestion: derive canonical name + aliases for a detected property. */
export async function enrichPropertyAliases(
  propertyName: string,
  existingAliases: string[] = []
): Promise<{ canonicalName: string; aliases: string[] }> {
  const resolved = await resolveProperty(propertyName);
  if (!resolved) {
    return {
      canonicalName: propertyName,
      aliases: [...new Set([propertyName, ...existingAliases])].filter(Boolean),
    };
  }
  return {
    canonicalName: resolved.canonicalName,
    aliases: [...new Set([...allNamesFor(resolved), ...existingAliases])],
  };
}
