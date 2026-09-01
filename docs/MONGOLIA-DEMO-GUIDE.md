# Mongolia Customer Demo Guide — Multilingual Retrieval (COP17)

**Goal:** Prove that MongoDB Atlas Vector Search with `voyage-4` embeddings is
**cross-lingual** — the corpus is written entirely in **Mongolian (Cyrillic)**,
yet **English queries retrieve the correct Mongolian documents**.

The content is the real **UNCCD COP17** conference FAQ (Ulaanbaatar, Mongolia),
covering Blue/Green Zone, Thematic Days, the Steppe Action Agenda, expected
outcomes, and the full e-Visa process — 20 Mongolian-language documents.

---

## The one-line pitch

> "Every document here is in Mongolian. I'm going to ask my questions in
> English. Watch the model find the right Mongolian answer anyway — same
> embedding model, no translation step, no per-language index."

---

## Setup (once)

The Mongolian docs are already seeded. If you need to reload:

```bash
cd property-ops-demo
npm run seed        # loads base + v2 + Mongolian COP17 FAQ, auto-embeds
npm run dev         # http://localhost:3100
```

- Embedding: **Atlas Auto Embedding** with `voyage-4` (multilingual) on
  `chunkText`. New Mongolian chunks embed automatically ~15s after insert.
- Mongolian docs: `language: ["mn"]`, `docId` prefix `COP17-FAQ-MN-*`.

> Pre-demo check: run any query below once so the vector index is warm.

---

## Demo flow

1. **Frame it.** Show that the corpus is Mongolian — open any result and point
   at the Cyrillic `chunkText`. Say: "I don't speak Mongolian, so I'll ask in
   English."
2. **Run the English queries below** (use **Compare** mode to show Vector /
   Hybrid / Rerank; then switch to **RAG Q&A** for a grounded answer).
3. **Point at the result:** the top hit is a Mongolian document with a high
   similarity score — retrieved from an English question.
4. **Show the query** (Show query button) to prove it's a single
   `$vectorSearch` with `voyage-4` auto-embedding — no translation, no separate
   Mongolian index.

---

## Demo queries (English in → Mongolian doc out)

All verified. Expected top document shown for reference.

| # | English query | Expected top Mongolian doc | Topic |
| --- | --- | --- | --- |
| 1 | `What is the difference between the Blue Zone and the Green Zone at COP17?` | Цэнхэр бүс ба Ногоон бүсийн ялгаа (MN-001) | Zones |
| 2 | `What are the COP17 Thematic Days?` | Сэдэвчилсэн өдрүүд (MN-002) | Programme |
| 3 | `How can youth and civil society participate in the conference?` | Олон нийт, залуучуудын оролцоо (MN-003) | Engagement |
| 4 | `What is the Steppe Action Agenda and how does it combat desertification and drought?` | Тал хээрийн төлөвлөгөө / Үр дүн (MN-004 / MN-005) | Agenda |
| 5 | `What outcomes are expected from COP17?` | Хүлээгдэж буй үр дүн (MN-005) | Outcomes |
| 6 | `Do I need a visa to attend COP17 in Mongolia?` | Виз шаардлагатай эсэх (MN-006) | Visa |
| 7 | `What documents do I need to submit for the e-visa application?` | Бүрдүүлэх бичиг баримт (MN-008) | Visa |
| 8 | `How long does it take to get my visa after applying and how many working days?` | Виз гарах хугацаа — ажлын 10 хоног (MN-014) | Visa |
| 9 | `Can I get a visa on arrival in Mongolia?` | Ирснийхээ дараа виз авах эсэх (MN-017) | Visa |
| 10 | `Is the COP17 visa valid for multiple entries?` | Олон удаа нэвтрэх эрх (MN-018) | Visa |

**Suggested 3-query short version:** #1 (Zones), #4 (Steppe Action Agenda),
#8 (visa timeline) — one conference-concept, one thematic, one practical.

---

## RAG Q&A (grounded answer demo)

Switch to the **RAG Q&A** tab and ask in English:

- `What is the difference between the Blue Zone and the Green Zone?`
- `How do I apply for a COP17 visa and what documents are required?`

The answer is generated grounded on the **Mongolian** source chunks — showing
the model reads Mongolian evidence and answers the English question, with the
cited Mongolian sources shown.

---

## What to emphasize

- **One model, many languages.** `voyage-4` embeds English queries and
  Mongolian documents into the same vector space — no translation layer.
- **No per-language indexing.** A single `vector_index` serves all languages.
- **Auto Embedding.** Insert a Mongolian doc → Atlas embeds it automatically →
  it's searchable in English within seconds.
- **Same architecture as any other language** — this scales to any customer's
  local language.
