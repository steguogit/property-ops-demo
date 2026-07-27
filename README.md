# Property Operations Assistant — MongoDB Atlas Retrieval Demo

A polished **local** demo that proves **MongoDB Atlas** can power an internal
operations assistant for a property-management company (managing office towers,
shopping malls, luxury residences, and residential estates).

It showcases, side-by-side, the difference between:

1. **Vector only** — semantic search over Voyage embeddings (`$vectorSearch`)
2. **Hybrid Search** — a single native **`$rankFusion`** pipeline fusing Atlas
   Vector Search + Atlas Search (lexical) server-side with RRF
3. **Vector + Reranker** — wide candidate pool reranked by a Voyage reranker
4. **RAG Q&A** — grounded answers with cited source chunks

**Built-in explainability for the demo:**

- A **MongoDB features** bar at the top lists the Atlas capabilities in play.
- Each result panel (and the RAG answer) has a **“Show query”** button that opens
  a modal with the MongoDB/Atlas features used **and the exact aggregation
  pipeline(s) executed** for that result (`$vectorSearch`, `$search`, `$project`,
  RRF, reranker).
- A **“Show data schema”** button opens a modal with the chunk JSON Schema, the
  live Atlas index definitions, and a real sample document pulled from your
  collection. Backed by `GET /api/schema`.

**Product message:** _The hard part is not generation. The hard part is
retrieving the right facts when the same property, staff member, or process
appears in different names, languages, or document formats_ — e.g.
`YOHO Mall = 形點`, `ICC = 環球貿易廣場`, `Peter Chan = 陳大文 = P. T. Chan`.

The corpus references **real public Hong Kong properties from both Henderson
Land (HLD) and Kaishing portfolios** (e.g. ICC, YOHO Mall / 形點, MOKO, Grand
YOHO, 珀麗灣 from Kaishing; MegaBox / 企業廣場, Metro City / 新都城, Double Cove /
迎海, The Henderson from HLD) so it resonates with either audience. **All
internal operational content — incidents, rosters, SOPs, contacts — is
synthetic.**

---

## 1. Prerequisites

- **Node.js 18+** (works on 20/22/25)
- A **MongoDB Atlas** cluster that supports **Atlas Search + Vector Search**
  (a free/shared M0 tier works for this small corpus, or M10+)
- A **Voyage AI** API key (used by the reranker; also by embeddings if you pick
  the explicit-Voyage strategy) — https://www.voyageai.com
- An Atlas cluster/region that supports **Automatic Embedding** (default
  strategy). Otherwise set `EMBEDDING_STRATEGY=voyage`.
- _(Optional)_ An LLM key for the RAG answer step — either a **Grove gateway**
  key (`LLM_*`) or an OpenAI-compatible key (`OPENAI_*`). Without one, RAG runs
  in **extractive** mode (still grounded, just no generated prose).

## 2. Setup

```bash
cd property-ops-demo
npm install
cp .env.example .env
# edit .env — set MONGODB_URI, VOYAGE_API_KEY, and (optional) LLM_* / OPENAI_*
```

Key env vars (see `.env.example` for all):

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas SRV connection string |
| `MONGODB_DB` / `MONGODB_COLLECTION` | defaults `property_ops_demo` / `chunks` |
| `VOYAGE_API_KEY` | Voyage embeddings + reranker |
| `VOYAGE_RERANK_MODEL` | default `rerank-2.5` |
| `EMBEDDING_STRATEGY` | `atlas` (default, auto-embedding) or `voyage` (explicit) |
| `ATLAS_AUTOEMBED_MODEL` | default `voyage-4` (voyage-4 family only) |
| `LLM_*` / `OPENAI_*` | optional, enables LLM RAG answers (Grove or OpenAI) |

## 3. Create Atlas indexes

```bash
npm run create-indexes          # create if missing
# or, to rebuild after changing EMBEDDING_STRATEGY:
npm run reindex                 # drop + recreate (different index shapes)
```

This creates two indexes via the driver:

- **Vector Search** index `vector_index` — on default (`atlas`) strategy this is
  an `autoEmbed` index over `chunkText` (Atlas embeds with `voyage-4`); on
  `voyage` strategy it indexes the stored `embedding` vector.
- **Atlas Search** index `lexical_index` over `chunkText`, `exactTerms`,
  `propertyAliases`, etc.

> Indexes take ~1–2 minutes to build. Check the Atlas UI **Search** tab.

**If programmatic creation fails** (some clusters restrict it), create them
manually in the Atlas UI using the JSON files in [`atlas-indexes/`](atlas-indexes):

- `atlas-indexes/vector_index.json` — Vector Search (explicit Voyage embeddings)
- `atlas-indexes/vector_index.autoembedding.json` — Vector Search using **Atlas
  Auto Embedding** (only if `EMBEDDING_STRATEGY=atlas`)
- `atlas-indexes/lexical_index.json` — Atlas Search

## 4. Seed the corpus

```bash
npm run seed
```

This reads [`seed/property_docs.json`](seed/property_docs.json) (18 documents),
chunks the content, generates **Voyage embeddings**, and writes everything into
Atlas. Re-running is idempotent (it clears and reloads).

Shortcut for indexes + seed:

```bash
npm run setup
```

Reset / reseed helpers:

```bash
npm run reset   # clears the collection
npm run seed    # reloads
```

## 5. Run the app

```bash
npm run dev
# open http://localhost:3000
```

The header pills show live status: Atlas connection + chunk count, Voyage
config, reranker, and whether RAG will use an LLM or extractive mode.

> Note: `npm run dev` and the Docker image both serve on **port 3100**
> (`http://localhost:3100`).

## 5b. Run in Docker (no terminal needed each time)

Run the app as a background container that starts automatically (including on
machine reboot) so you don't have to launch it from a terminal every time.

**Prerequisites:** Docker Desktop running, and a populated `.env`
(`cp .env.example .env` then fill in `MONGODB_URI`, keys, etc.).

```bash
docker compose up -d --build     # build once + start in the background
# open http://localhost:3100
```

Everyday control (also available as buttons in the Docker Desktop UI under the
`property-ops-demo` container):

```bash
docker compose logs -f           # watch logs
docker compose restart           # restart
docker compose down              # stop and remove the container
docker compose up -d             # start again (no rebuild)
```

Rebuild after code changes: `docker compose up -d --build`.

Details:

- The container reads your local `.env` at runtime via `env_file` — secrets are
  **never** baked into the image (`.env` is in `.dockerignore`).
- `restart: unless-stopped` means it comes back automatically after a reboot or
  crash, until you explicitly `docker compose down`.
- Uses the Next.js **standalone** output (`output: "standalone"`) for a small
  image; Tesseract OCR `*.traineddata` files are copied in for image OCR.
- **Atlas connectivity is the same as running locally:** the container connects
  to Atlas only when your current IP is allow-listed in **Atlas → Network
  Access**. The header shows `Atlas not connected` until then; the MongoDB
  driver retries automatically (no container restart required).
- The seed / index / migration scripts still run from a terminal against Atlas
  (`npm run setup`, `npm run seed-policies`, …) — they are one-off admin tasks,
  not part of the running server.

---

## 6. Demo script (the queries that show the difference)

Use the **Q1–Q6** chips in the UI. Run each in **Compare** mode first, then
switch to **RAG Q&A**.

| # | Query | What to point out |
| --- | --- | --- |
| 1 | `Is YOHO Mall the same property as 形點?` | Hybrid/rerank surface the **alias master** + fact sheet because `形點` is an exact lexical term; vector-only may drift. |
| 2 | `Find the overnight contractor access procedure for YOHO Mall fitting-out works` | Exact SOP `SOP-YOHO-ACCESS-001` ranks #1 under hybrid — precise wording matters. |
| 3 | `What is the escalation process for water leakage at Grand YOHO?` | `SOP-WATER-RES-001` + the Grand YOHO incident + on-call roster. |
| 4 | `Find HVAC complaint handling for 環球貿易廣場` | Chinese alias for ICC resolves to the HVAC SOP + ICC incident — bilingual retrieval. |
| 5 | `Who is Peter Chan linked to in duty roster records?` | Roster shows `Peter Chan = Chan Tai Man = P. T. Chan = 陳大文` — entity linkage. |
| 6 | `Summarize the after-hours handling process for urgent maintenance at Grand YOHO and cite the relevant SOP and contact records` | RAG produces a grounded answer citing the SOP + roster + FAQ. |

Nice-to-have queries that also work:

- `Which documents apply to mall tenants versus residents?`
- `Show all records related to MOKO lift outage handling`
- `Which property records mention both contractor access and loading bay arrangements?`

**Why hybrid wins:** hybrid runs as a single `$rankFusion` aggregation that
fuses the `$vectorSearch` and `$search` sub-pipelines server-side with RRF. The
lexical sub-pipeline boosts `exactTerms` / `propertyAliases` (boost x5), so exact
property aliases (`形點`, `環球貿易廣場`) and precise policy phrases (`overnight
work permit`, `loading bay arrangement`) are not lost to pure semantic
similarity. `scoreDetails` exposes each arm's contribution. The reranker then
tightens final ordering.

---

## 7. Architecture

```
seed/property_docs.json   ── 18 synthetic property-management docs
scripts/
  create-indexes.ts       ── creates Atlas Vector + Search indexes
  seed.ts                 ── chunk + Voyage embed + write to Atlas
  reset.ts                ── clear collection
  chunk.ts                ── sentence-aware chunker
atlas-indexes/*.json      ── index definitions for the Atlas UI
src/lib/
  mongo.ts                ── Atlas client + ChunkDoc schema
  voyage.ts               ── Voyage embeddings + reranker
  retrieval.ts            ── vector / hybrid ($rankFusion) / vector+rerank
  rag.ts                  ── grounded answer (LLM or extractive fallback)
src/app/api/
  search/route.ts         ── runs the 3 retrieval modes in parallel (+ explain)
  rag/route.ts            ── RAG endpoint (+ explain)
  status/route.ts         ── config + corpus health for the UI
  schema/route.ts         ── JSON schema + index defs + live sample doc
src/lib/explain.ts        ── builds the features + real pipelines per mode
src/components/Modal.tsx  ── modal + JSON code block (Show query / Show schema)
src/app/page.tsx          ── compare console + RAG tab
```

### Data model (`chunks` collection)

Chunk-oriented documents with `docId`, `docType`, `title`, `propertyName`,
`propertyAliases`, `segment`, `language`, `audience`, `tags`, `exactTerms`,
`extractedFields`, `chunkText`, `chunkIndex`, and `embedding`. The same metadata
is duplicated onto every chunk so lexical boosting works per-chunk.

---

## 7b. Iteration 2 — Document ingestion, versioning & human correction

This iteration extends the retrieval lab into a **practical near-term operations
solution**: upload real documents, review what was extracted, keep version
history, resolve property names across years, and let a human correct the
model's interpretation **without editing any prompt**. It deliberately does
**not** attempt impact analysis, sensor reasoning, or floor-plan spatial
comparison — those are acknowledged as future phases.

### What's new

| Capability | How it works |
| --- | --- |
| **Upload & ingestion** | `POST /api/upload` (multipart). Extracts text, OCRs images, chunks, alias-enriches, embeds, and writes `documents` + `chunks` with full source-to-chunk traceability. |
| **Text extraction** | PDF (`pdf-parse`), DOCX (`mammoth`), Excel/CSV (`xlsx`), PPTX (`jszip` slide XML), images (`tesseract.js` OCR + optional LLM-vision pass). `src/lib/extract.ts`. |
| **Review experience** | "Upload & Review" tab: file name/type, extracted-text preview, chunk count, OCR used, embedding status, version tag, obsolete flag, alias tags, and review status. |
| **Version awareness** | `versionGroupId` links revisions; newest (by `effectiveFrom`) is current, older marked `obsoleteFlag`. Retrieval **prefers newest** by default; toggle "Include obsolete" to search history. `src/lib/versioning.ts`. |
| **Alias / naming** | `property_aliases` master holds canonical + EN/ZH/historical names. Queries are alias-expanded so `形點` also benefits from `YOHO Mall`. `src/lib/aliases.ts`. |
| **Human correction (legacy)** | "Human Corrections (legacy)" tab. Pin/demote a source, clarify a term's meaning, prefer a version, or flag a wrong interpretation — applied at the **data layer** and reversible. `src/lib/corrections.ts`. **Superseded by the Knowledge Policy Layer.** |
| **Knowledge Policy Layer** | "Knowledge Policies" tab. A governed, human-approved correction layer: feedback → AI-drafted `CorrectionProposal` → human approval → deterministic active `KnowledgePolicy` → `PolicyApplicationTrace`. AI assists, humans govern, runtime applies approved policy deterministically. Seed the demo with `npm run seed-policies`; migrate legacy corrections with `npm run migrate-policies`. See [`docs/knowledge-policy-layer.md`](docs/knowledge-policy-layer.md). |

### New collections

- `documents` — one record per uploaded file (metadata, extracted text, OCR
  flag, extraction method/caveat, chunk count, embedding status, version +
  review status).
- `property_aliases` — canonical property identity + aliases + historical names.
- `document_versions` — version groups linking revisions, current vs obsolete.
- `user_corrections` — human corrections applied at query time.
- `ingestion_jobs` — per-upload step-by-step audit trail.

`chunks` gains: `documentId`, `sourceFileType`, `versionLabel`,
`versionGroupId`, `obsoleteFlag`, `supersededBy`, `effectiveFrom`, `ocrUsed`,
`relatedDocumentIds`.

### Ingestion flow

```
upload → extractText (pdf/docx/xlsx/csv/pptx/image + OCR + LLM-vision fallback)
       → enrichPropertyAliases (canonical + EN/ZH/historical)
       → chunk (sentence-aware)
       → write documents record (+ extractedTextPreview)
       → write chunks (documentId traceability + version/obsolete fields)
       → embed (Atlas auto-embedding, or explicit Voyage)
       → ingestion_jobs audit trail
```

### Retrieval flow (enhanced)

`runSearchEnhanced` wraps the existing vector / hybrid / rerank primitives and
layers on:
1. **alias expansion** of the query string,
2. a **version-aware filter** (`{ obsoleteFlag: { $ne: true } }`) applied to
   both the vector and lexical arms — with **graceful degradation** (if the
   Atlas index doesn't yet have the filter field, it retries unfiltered and
   filters obsolete in-app),
3. **human-correction overlays** (pin/demote ordering + term-meaning grounding),
4. trims back to the requested limit.

RAG (`runRag`) uses the same enhanced retrieval and injects reviewer
term-clarifications as authoritative grounding context.

### Indexes — re-run after upgrading

The new lifecycle fields are added as Atlas **filter** fields. Re-create the
indexes so version-aware filtering runs server-side:

```bash
npm run reindex   # drop + recreate with obsoleteFlag/versionLabel/... filters
npm run seed      # reloads base + v2 docs, property_aliases, document_versions
```

> Until you reindex, version filtering still works — it falls back to in-app
> obsolete filtering automatically (you'll see slightly wider candidate pools).

### Supported file types & caveats

**Strong now:** PDF (text layer), DOCX, CSV, simple Excel, PPTX text, image OCR
(EN/ZH), Atlas storage + vector/hybrid/reranked retrieval, version metadata,
alias mapping, grounded RAG, human-correction capture.

**Partial / caveated:** complex Excel semantics (formulas/merged cells/pivots),
diagram-heavy PPTX, scanned/image-only PDFs (no local page rasterisation —
re-upload page images for OCR), image understanding beyond OCR/caption.

**Future phase / out of scope here:** utility-shutoff impact analysis across
merchants (`關水喉`/`關電源`), cross-sensor relationship reasoning, advanced IoT
analytics, floor-plan spatial comparison. The sample CLP/中電 CSV demonstrates
ingestion + retrieval of utility data only (CLP has no API — manual CSV).

### Suggested demo storyline

1. **Upload & Review** — drop the sample 2023 ICC chiller O&M PDF (or any file);
   inspect extracted text, chunking, OCR flag, version tag.
2. **Compare** `What is the current chiller plant shutdown procedure for ICC?` —
   the **2023 current** edition ranks above the obsolete 2009/2016 editions.
   Toggle "Include obsolete" to see history reappear.
3. **Floor-plan continuity** — `Did the fire / 消防 layout change when 6F was
   reconfigured to 8F?` shows partial continuity (office layout changed, fire
   layout unchanged).
4. **Alias / history** — `MOKO` vs historical `Grand Century Place` both resolve.
5. **Grounded answer**, then **Human Corrections** — clarify a term (e.g.
   `關水喉` = shut the supply valve) or pin a better source, and watch retrieval
   change with **no prompt edits**.

### Phased delivery recommendation

- **Phase 1 (this build):** ingestion, extraction+OCR, version metadata, alias
  mapping, version-aware retrieval, human corrections, grounded RAG. ✅
- **Phase 2:** scanned-PDF page rasterisation for OCR; richer Excel table
  semantics; correction-driven re-embedding; reviewer dashboards/metrics.
- **Phase 3 (data-dependent):** utility-shutoff impact analysis across
  merchants, cross-sensor relationships, floor-plan semantic comparison — only
  once the supporting structured data (merchant→circuit maps, sensor graphs) is
  available.

### Prioritized next-iteration tasks

1. Run `npm run reindex && npm run seed` so version filters run server-side.
2. Wire scanned-PDF rasterisation (server-side `pdf-to-image`) into the OCR path.
3. Add a Versions UI panel (link/relink revisions, set current) over
   `POST /api/versions`.
4. Capture correction provenance per user and add a "corrections that fired"
   audit view in the explain modal.
5. Map merchants→electrical circuits to begin Phase-3 impact analysis on real
   data.

---

## 8. Embedding strategy: Atlas Auto Embedding (default) vs explicit Voyage

This build **defaults to Atlas Automatic Embedding** (`EMBEDDING_STRATEGY=atlas`).
This is the low-code path and — importantly — it keeps embeddings in sync with
your data automatically:

- The vector index uses an `autoEmbed` field on `chunkText`
  (`atlas-indexes/vector_index.autoembedding.json`). Atlas embeds each chunk on
  **insert/update**, and embeds the **query string** at search time.
- `scripts/seed.ts` does **not** embed locally; it just writes `chunkText`.
- `src/lib/retrieval.ts` issues `$vectorSearch` with `{ path: "chunkText",
  query }` — no client-side embedding call.

> **Why your earlier edits didn't show up:** the original setup used explicit
> Voyage embeddings with a classic vector index over a stored `embedding` field.
> Editing a record did **not** re-embed it, so its vector was stale (or the new
> record had no vector at all) and `$vectorSearch` couldn't rank it. With Atlas
> Auto Embedding, **editing a record auto-updates its vector within seconds — no
> re-seed needed.** (Verified: an edited chunk became the #1 vector hit ~15s
> after the update, with no seed step.)

**Requirements / gotchas for Atlas Auto Embedding:**

- Model must be a **voyage-4 family** model: `voyage-4` (default),
  `voyage-4-lite`, `voyage-4-large`, or `voyage-code-3`. (`voyage-3` is **not**
  accepted by `autoEmbed`.) Configure via `ATLAS_AUTOEMBED_MODEL`.
- The index field shape is `{ type: "autoEmbed", path, modality: "text",
  model }`.
- Switching strategies requires rebuilding the vector index (different shape):
  `npm run reindex` (drops + recreates), then `npm run seed`.

**Explicit Voyage fallback** (`EMBEDDING_STRATEGY=voyage`):

- `seed.ts` calls Voyage `/embeddings` and writes the `embedding` array per
  chunk; index from `atlas-indexes/vector_index.json` (a `vector` field).
- After **any** data change you must re-run `npm run seed` to refresh vectors.
- Use this if your cluster/region doesn't offer automatic embedding.

The **reranker** (`src/lib/voyage.ts → voyageRerank`) is always Voyage and is
independent of the embedding strategy. It is optional: if `VOYAGE_API_KEY` is
absent, `Vector + Reranker` degrades to vector ordering and RAG falls back to
hybrid retrieval.

> **Voyage free-tier note:** without a payment method on the Voyage account, the
> reranker is limited to **3 requests/minute**. Atlas Auto Embedding removes
> Voyage from the embedding path entirely, so only the reranker touches Voyage.
> Add a payment method (200M free tokens still apply) before a live demo.

## 8b. LLM for RAG (Grove gateway or OpenAI)

RAG answers use whichever LLM you configure. Two supported shapes:

- **Grove gateway** (Azure API Management, `api-key` header) — set `LLM_PROVIDER`,
  `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`. Example in `.env.example`.
- **OpenAI-compatible** (`Authorization: Bearer`) — set `OPENAI_API_KEY`,
  `OPENAI_BASE_URL`, `OPENAI_MODEL`.

`LLM_*` takes precedence. If neither is set, RAG runs in **extractive** mode
(grounded, no generated prose). The header style is chosen automatically:
`api-key` when `LLM_PROVIDER` is set, otherwise `Bearer`.

---

## 9. Troubleshooting

- **`Atlas not connected`** — check `MONGODB_URI` and that your IP is allow-listed.
- **Edited records don't appear / wrong ranking** — make sure
  `EMBEDDING_STRATEGY=atlas` and the vector index is the `autoEmbed` form. On the
  explicit `voyage` strategy you must re-run `npm run seed` after every edit.
- **`Unsupported model 'voyage-3' in index`** — Atlas `autoEmbed` only accepts
  voyage-4 family models; set `ATLAS_AUTOEMBED_MODEL=voyage-4`.
- **Empty vector results** — the vector index may still be building. Check it is
  `READY`/queryable in the Atlas Search tab.
- **`Voyage rerank error 429`** — Voyage free-tier rate limit (3 RPM); add a
  payment method, or just click more slowly during the demo.
- **Hybrid returns only vector hits** — the Atlas Search index name must match
  `ATLAS_SEARCH_INDEX` and be in `READY` state.
- **RAG says "extractive"** — no LLM key configured; this is expected and still
  shows grounded source evidence.
