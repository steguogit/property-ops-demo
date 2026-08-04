# FSI Expansion — Usage (Phase 1 + 2)

This adds a second dataset **mode** to the demo alongside Property Management:
**FSI Funding Reach — Address Verification**. Both datasets live in the same
`chunks` collection, isolated by the `metadataType` field
(`"property"` | `"fsi"`).

## Switching mode (no restart)

Use the dataset dropdown in the top-right of the header:

- **Property Management** → title *Property Operations Assistant*, searches only
  property data (`metadataType = "property"`, plus legacy docs with no marker).
- **FSI Funding Address Verification** → title *FSI Funding Reach — Address
  Verification · Geo + Vector Hybrid Search*, searches only FSI data
  (`metadataType = "fsi"`).

The choice persists in `localStorage` and is sent as `metadataType` on every
search / RAG request, so the two datasets never mix.

## Seeding / resetting the FSI dataset

The FSI seed only touches `metadataType = "fsi"` documents — it never disturbs
the property dataset.

```bash
# generate + (re)load the FSI Hong Kong building test data
npx tsx scripts/seed-fsi.ts

# clear FSI docs first, then reseed a fresh copy
npx tsx scripts/seed-fsi.ts --purge
```

The generated data contains the same buildings on multiple floors (e.g. 5/F,
8/F, 12/F) and units, each address written in several Hong Kong formats
(English, 中文, `8/F` vs `八樓`, `Block` vs `座`, `Flat` vs `室`). Coordinates for
all units of one building are nearly identical (synthetic HK coordinates) so the
floor-disambiguation problem is reproducible for Phase 4.

## Index update (one-time, required)

`metadataType` (and FSI structured fields) were added as filter fields to the
Atlas vector + search indexes. Recreate the indexes so server-side filtering
works:

```bash
npx tsx scripts/create-indexes.ts --recreate
```

## What is NOT in this phase

- Geo (`2dsphere` / `$geoNear`) pre-filtering — coordinates are seeded but not
  yet queried.
- Floor-exact rank boosting (fixes "5/F & 8/F interleaved" ordering).
- Reranker call point for FSI.

These are Phase 4 and require new aggregation logic (the current codebase has no
geospatial layer). See the analysis in the chat history for effort estimates.
