# Agentic Architecture — Design & Migration Plan

Status: **design proposal** (no runtime change yet). This document analyses
whether the Property Operations Assistant should move to an agentic
architecture, proposes a concrete target design, and gives a low-risk,
incremental migration path that **wraps existing code rather than rewriting it**.

---

## 1. Can we go agentic? — short answer

**Yes, and the codebase is already well-positioned for it.** The system is
today a set of clean, single-responsibility pipeline functions:

| Concern | Today (function) | File |
| --- | --- | --- |
| Ingestion orchestration | `ingestFile()` | `src/lib/ingest.ts` |
| Text extraction / OCR | `extractText()` | `src/lib/extract.ts` |
| Embedding | `voyageEmbed*()`, Atlas auto-embed | `src/lib/voyage.ts` |
| Retrieval | `runSearchEnhanced()` + primitives | `src/lib/retrieval.ts` |
| Answer generation | `runRag()` / `chatRag()` | `src/lib/rag.ts` |
| Governance | policy resolver / proposals | `src/lib/policy-*.ts` |

These map almost 1:1 onto **agents**. An agent is just a bounded worker with a
declared capability, an input/output contract, and (optionally) the autonomy to
choose *how* to accomplish its task. We already have the "what"; the agentic
layer adds a thin "who decides how + in what order" on top.

The key design decision is **how much autonomy** each agent gets. There is a
spectrum:

- **Deterministic orchestration (recommended first step).** An orchestrator
  calls specialised agents in a fixed graph. Agents encapsulate logic but do not
  free-form plan. Fully predictable — ideal for a demo.
- **Tool-calling agents (selective).** Give one or two agents an LLM + tools so
  they can *choose* a strategy (e.g. the Extraction agent picks OCR engine; the
  Retrieval agent picks vector vs hybrid vs rerank based on the query). Bounded
  autonomy, high demo value ("watch it decide").
- **Fully autonomous multi-agent (not recommended now).** Agents plan, spawn
  sub-tasks, and negotiate. Highest wow-factor, highest risk/latency/cost — poor
  fit for a live sales demo.

**Recommendation:** implement deterministic orchestration + a shared agent
trace, then selectively upgrade the Extraction and Retrieval agents to
tool-calling. This gives the "agentic" story and the visible reasoning trace
without destabilising the demo.

---

## 2. Target agent model

```
                         ┌────────────────────────┐
                         │      Orchestrator       │
                         │  (plans + routes work,  │
                         │   records AgentTrace)   │
                         └───────────┬─────────────┘
        ingestion path               │             retrieval / answer path
   ┌───────────────────────┬─────────┴───────────┬───────────────────────┐
   ▼                       ▼                     ▼                       ▼
┌──────────┐        ┌──────────────┐      ┌──────────────┐       ┌──────────────┐
│Ingestion │        │ Extraction   │      │  Retrieval   │       │   RAG /      │
│  Agent   │───────▶│    Agent     │      │    Agent     │──────▶│ Answer Agent │
│(pipeline │        │(OCR strategy)│      │(mode + filter│       │ (ground +    │
│ manager) │        └──────┬───────┘      │  selection)  │       │  cite + LLM) │
└────┬─────┘               │              └──────┬───────┘       └──────────────┘
     │              ┌──────▼───────┐             │
     │              │  Embedding   │             ▼
     └─────────────▶│    Agent     │      ┌──────────────┐
                    │ (vectorise)  │      │  Governance  │
                    └──────────────┘      │    Agent     │
                                          │ (policies /  │
                                          │  corrections)│
                                          └──────────────┘
```

### Agent responsibilities & contracts

Each agent implements a common interface so the orchestrator can invoke,
time, and trace them uniformly.

```ts
interface Agent<In, Out> {
  name: string;                       // e.g. "extraction"
  run(input: In, ctx: AgentContext): Promise<AgentResult<Out>>;
}

interface AgentContext {
  datasetId: string;                  // dataset isolation is first-class
  traceId: string;
  emit(step: AgentStep): void;        // for the live UI trace / SSE
  llm?: LlmClient;                    // only tool-calling agents receive this
}

interface AgentResult<Out> {
  output: Out;
  steps: AgentStep[];                 // what it did + why (for explainability)
  decisions?: AgentDecision[];        // strategy choices, with rationale
}
```

| Agent | Wraps today | Input → Output | Autonomy |
| --- | --- | --- | --- |
| **Ingestion** | `ingestFile()` orchestration | file → documentId + summary | deterministic (manages the sub-agents) |
| **Extraction** | `extractText()` | bytes → text + OCR meta | *tool-calling candidate*: choose tesseract / ONNX / vision / external Paddle by file signal |
| **Embedding** | `voyageEmbed*` / Atlas auto | chunks → vectors | deterministic (strategy from config) |
| **Retrieval** | `runSearchEnhanced()` | query → hits | *tool-calling candidate*: choose vector / hybrid / rerank + build filter |
| **Governance** | policy resolver + corrections | query + hits → adjusted hits + trace | deterministic (authoritative, must stay deterministic) |
| **RAG / Answer** | `runRag()` / `chatRag()` | hits → grounded answer + citations | deterministic prompt; LLM does generation only |

> **Design guardrail:** the **Governance agent stays deterministic**. The
> Knowledge Policy Layer's whole value proposition (see
> `docs/knowledge-policy-layer.md`) is that approved business rules are applied
> the same way every time. Agentic autonomy must never re-decide an approved
> policy at runtime — agents *consume* approved policy, they don't override it.

---

## 3. Orchestration

Two orchestration flows, both driven by one `Orchestrator`:

**Ingestion flow** (fixed graph, high determinism):
`Ingestion → Extraction → (chunk) → Embedding → persist`. The orchestrator
records each sub-agent's steps into a single `AgentTrace`, which the existing
"behind the scenes" UI already visualises (it consumes timed steps today; it
would consume `AgentStep[]` tomorrow — same shape).

**Query flow** (light autonomy):
`Retrieval → Governance → Answer`. The Retrieval agent may consult the LLM to
classify the query (e.g. "alias lookup" vs "procedure" vs "entity linkage") and
pick a mode + candidate-pool size, then hand off. Governance applies approved
policies deterministically. Answer generates + cites.

### Where the LLM tool-calling boundary sits

Only two agents get tools, and their tools are **narrow and safe**:

- **Extraction agent tools:** `detectFileKind`, `runOcr(engine)`,
  `runVisionOcr`, `probeTextLayer`. It picks an engine, can retry with a
  stronger one if confidence is low, and records *why*.
- **Retrieval agent tools:** `vectorSearch`, `hybridSearch`, `rerankSearch`,
  `expandAliases`, `buildDatasetFilter(datasetId)`. It selects a strategy and
  explains the choice.

Everything else is a normal function call. This keeps latency, cost, and
failure modes bounded while still producing a genuine "the agent decided…"
narrative for the demo.

---

## 4. Explainability = the demo payoff

The existing app already leans hard on explainability ("Show query", policy
traces, the new behind-the-scenes ingestion rail). An agentic layer extends this
naturally into an **Agent Trace panel**:

- per-agent timeline (start/end, duration),
- each agent's **decisions with rationale** (chosen OCR engine, chosen retrieval
  mode, applied policies),
- the exact tool calls an autonomous agent made.

This is stored as a new `agent_traces` collection (mirrors
`policy_application_traces`) and streamed live via SSE to the UI. It turns the
architecture change itself into a demo feature.

---

## 5. Migration plan (incremental, low-risk)

Each phase ships independently and leaves the app fully working.

**Phase 0 — foundations (small).**
- Add `src/lib/agents/` with the `Agent`, `AgentContext`, `AgentResult` types
  and an `Orchestrator` that just calls functions and collects steps.
- Add an `agent_traces` collection + `GET /api/traces/agent`.
- No behavioural change: orchestrator wraps `ingestFile` and `runRag` 1:1.

**Phase 1 — wrap ingestion as agents.**
- Extract `IngestionAgent`, `ExtractionAgent`, `EmbeddingAgent` by moving the
  relevant blocks of `ingestFile()` behind the agent interface. Pure
  refactor — same DB writes, same outputs.
- Feed `AgentStep[]` into the existing behind-the-scenes UI (rename source, keep
  shape).

**Phase 2 — wrap query path as agents.**
- Extract `RetrievalAgent`, `GovernanceAgent`, `AnswerAgent` from
  `runSearchEnhanced` / `runRag` / `chatRag`. Governance stays deterministic.

**Phase 3 — selective autonomy + Agent Trace UI.**
- Give Extraction and Retrieval agents an LLM client + their narrow tools.
- Add the live Agent Trace panel (SSE) showing decisions and rationale.

**Phase 4 — optional advanced agents (data-dependent).**
- e.g. a `VersioningAgent` that proposes version links across uploads, or an
  `ImpactAgent` for utility-shutoff analysis — only once the supporting data
  exists (see README Phase 3 notes).

### Effort / risk

| Phase | Rough effort | Risk | Demo value |
| --- | --- | --- | --- |
| 0 | 0.5 day | very low | plumbing |
| 1 | 1–2 days | low (refactor) | medium |
| 2 | 1–2 days | low–medium | medium |
| 3 | 2–4 days | medium (LLM latency/cost) | **high** |
| 4 | data-dependent | varies | high, situational |

---

## 6. Risks & mitigations

- **Latency/cost from LLM-in-the-loop.** Mitigate by limiting tool-calling to
  Extraction + Retrieval, caching query classification, and keeping a
  deterministic fast-path fallback (if the agent's LLM call fails, fall back to
  today's default mode).
- **Non-determinism vs governance.** Governance agent remains deterministic;
  autonomy is confined to *strategy selection*, never to *business meaning*.
- **Debuggability.** The `agent_traces` collection + Agent Trace UI make every
  decision inspectable — arguably *more* debuggable than the current implicit
  flow.
- **Scope creep.** Phases are independently shippable; stop after Phase 2 if the
  autonomy story isn't needed for a given audience.

---

## 7. Recommendation

Proceed through **Phase 0 → 2** to get a clean, traced, agent-structured system
with zero behavioural risk, then do **Phase 3** for the specific customer demos
where "watch the agents decide" is the selling point. Defer Phase 4 until the
underlying structured data is available.
