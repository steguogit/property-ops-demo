"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";

// ---------------------------------------------------------------------------
// Lightweight i18n for UI chrome (menus, buttons, labels, notices, dialogs).
// English + Traditional Chinese (zh-Hant). No external library: a React Context
// holds the active language, `t(key)` looks up a string, and the choice is
// persisted to localStorage. Data/content (documents, RAG answers, lib-generated
// explanation prose) is intentionally NOT translated here.
// ---------------------------------------------------------------------------

export type Lang = "en" | "zh";

type Dict = Record<string, { en: string; zh: string }>;

// All translatable UI-chrome strings, grouped by area via key prefixes.
export const DICT: Dict = {
  // ----- Header / brand -----
  "app.title": {
    en: "Property Operations Assistant",
    zh: "物業營運助理",
  },
  "app.tagline": {
    en: "MongoDB Atlas retrieval lab — Vector vs Hybrid vs Reranked, with grounded RAG",
    zh: "MongoDB Atlas 檢索實驗室 — 向量 / 混合 / 重新排序比較，並提供有依據的 RAG",
  },
  "header.langToggle": { en: "中文", zh: "EN" },
  "header.langToggleTitle": {
    en: "切換至繁體中文",
    zh: "Switch to English",
  },

  // ----- Status pills -----
  "pill.atlasChunks": { en: "Atlas · {n} chunks", zh: "Atlas · {n} 個片段" },
  "pill.atlasDisconnected": {
    en: "Atlas not connected",
    zh: "Atlas 未連線",
  },
  "pill.docs": { en: "{n} docs", zh: "{n} 份文件" },
  "pill.corrections": { en: "{n} corrections", zh: "{n} 項修正" },
  "pill.embed": { en: "embed: {model}", zh: "嵌入：{model}" },
  "pill.rerank": { en: "Rerank {model}", zh: "重新排序 {model}" },
  "pill.rerankOff": { en: "Rerank off", zh: "重新排序關閉" },
  "pill.rag": { en: "RAG · {model}", zh: "RAG · {model}" },
  "pill.ragExtractive": { en: "RAG extractive", zh: "RAG 擷取式" },

  // ----- Intro message -----
  "intro.bold": {
    en: "The hard part is not generation — it's retrieval.",
    zh: "困難的不是生成，而是檢索。",
  },
  "intro.rest": {
    en: "The same property, staff member, or process shows up under different names, languages, and document formats. This console shows why exact entity + lexical matching, fused with vector search and reranking, retrieves the right facts.",
    zh: "同一個物業、員工或流程會以不同的名稱、語言和文件格式出現。此控制台展示為何精確的實體 + 詞彙比對，結合向量搜尋與重新排序，能檢索出正確的資訊。",
  },

  // ----- Feature bar -----
  "features.label": { en: "MongoDB features", zh: "MongoDB 功能" },
  "features.vectorSearch": { en: "Atlas Vector Search", zh: "Atlas 向量搜尋" },
  "features.atlasSearch": { en: "Atlas Search (BM25)", zh: "Atlas 搜尋 (BM25)" },
  "features.rankFusion": {
    en: "$rankFusion (hybrid)",
    zh: "$rankFusion（混合）",
  },
  "features.autoEmbed": { en: "Atlas Auto Embedding", zh: "Atlas 自動嵌入" },
  "features.voyageEmbed": { en: "Voyage Embeddings", zh: "Voyage 嵌入" },
  "features.reranker": { en: "Voyage Reranker", zh: "Voyage 重新排序器" },
  "features.ingestion": {
    en: "Document Ingestion + OCR",
    zh: "文件匯入 + OCR",
  },
  "features.versionFilters": {
    en: "Version-aware Filters",
    zh: "版本感知篩選",
  },
  "features.corrections": { en: "Human Corrections", zh: "人工修正" },
  "features.aggregation": { en: "Aggregation Pipeline", zh: "聚合管線" },
  "features.showSchema": { en: "{ } Show data schema", zh: "{ } 顯示資料綱要" },

  // ----- Query bar -----
  "query.placeholder": {
    en: "Ask an operations question in English or Chinese…",
    zh: "以中文或英文輸入營運問題…",
  },
  "query.compare": { en: "Compare", zh: "比較" },
  "query.answer": { en: "Answer", zh: "回答" },
  "query.searchByImage": { en: "Search by image", zh: "以圖搜尋" },
  "query.imageAttached": {
    en: "Image attached — click Compare to search by image",
    zh: "已附加圖片 — 按「比較」以圖搜尋",
  },
  "query.imageMode": { en: "Image search", zh: "圖片搜尋" },
  "query.removeImage": { en: "Remove", zh: "移除" },
  "query.hybridWeighting": { en: "Hybrid weighting — lexical", zh: "混合權重 — 詞彙" },
  "query.vector": { en: "vector", zh: "向量" },
  "query.weights": {
    en: "lexical {lex} · vector {vec}",
    zh: "詞彙 {lex} · 向量 {vec}",
  },
  "query.includeObsolete": {
    en: "Include obsolete versions",
    zh: "包含已淘汰版本",
  },
  "query.includeObsoleteTitle": {
    en: "Exclude superseded versions by default (prefer newest)",
    zh: "預設排除已被取代的版本（優先最新）",
  },
  "query.applyCorrections": { en: "Apply human corrections", zh: "套用人工修正" },
  "query.applyCorrectionsTitle": {
    en: "Apply stored human corrections (pin/demote/term meaning)",
    zh: "套用已儲存的人工修正（置頂／降權／詞義）",
  },
  "query.aliasExpansion": { en: "Alias expansion", zh: "別名擴展" },
  "query.aliasExpansionTitle": {
    en: "Expand the query with known property aliases",
    zh: "以已知的物業別名擴展查詢",
  },

  // ----- Tabs -----
  "tab.dashboard": { en: "Dashboard", zh: "儀表板" },
  "tab.compare": { en: "Compare retrieval modes", zh: "比較檢索模式" },
  "tab.modelCompare": { en: "Compare embedding models", zh: "比較嵌入模型" },
  "tab.rag": { en: "RAG Q&A", zh: "RAG 問答" },
  "tab.chat": { en: "Conversational RAG", zh: "對話式 RAG" },
  "tab.signatures": { en: "Signature Comparison", zh: "簽名對比" },

  // ----- Dashboard -----
  "dash.title": { en: "Operations Dashboard", zh: "營運儀表板" },
  "dash.sub": {
    en: "Key metrics for the active demo",
    zh: "目前展示資料集的關鍵指標",
  },
  "dash.refresh": { en: "Refresh", zh: "重新整理" },
  "dash.error": { en: "Failed to load metrics", zh: "載入指標失敗" },
  "dash.kpi.documents": { en: "Documents", zh: "文件" },
  "dash.kpi.chunks": { en: "Chunks", zh: "片段" },
  "dash.kpi.aliases": { en: "Aliases", zh: "別名" },
  "dash.kpi.tokens": { en: "Tokens used", zh: "已用代幣" },
  "dash.kpi.calls": { en: "calls", zh: "次呼叫" },
  "dash.kpi.needsReview": { en: "Needs review", zh: "待審核" },
  "dash.kpi.obsolete": { en: "Obsolete docs", zh: "過時文件" },
  "dash.kpi.current": { en: "current", zh: "現行" },
  "dash.corpus.title": { en: "Corpus", zh: "語料庫" },
  "dash.corpus.tag": { en: "content", zh: "內容" },
  "dash.corpus.byType": { en: "By document type", zh: "依文件類型" },
  "dash.corpus.byProperty": { en: "By property", zh: "依物業" },
  "dash.corpus.byFile": { en: "By file type", zh: "依檔案類型" },
  "dash.ingest.title": { en: "Ingestion", zh: "文件匯入" },
  "dash.ingest.jobs": { en: "jobs", zh: "項作業" },
  "dash.ingest.embedStatus": { en: "Embedding status", zh: "嵌入狀態" },
  "dash.ingest.avgStep": {
    en: "Avg time per pipeline step",
    zh: "各管線步驟平均耗時",
  },
  "dash.gov.title": { en: "Review & Governance", zh: "審核與治理" },
  "dash.gov.tag": { en: "quality", zh: "品質" },
  "dash.gov.review": { en: "Review status", zh: "審核狀態" },
  "dash.gov.signature": { en: "Signature status", zh: "簽名狀態" },
  "dash.gov.policies": { en: "active policies", zh: "項生效政策" },
  "dash.gov.corrections": { en: "active corrections", zh: "項生效修正" },
  "dash.tokens.title": { en: "Token Usage", zh: "代幣用量" },
  "dash.tokens.byOperation": { en: "By operation", zh: "依操作" },
  "dash.tokens.byProvider": { en: "By provider", zh: "依供應商" },
  "dash.tokens.byModel": { en: "By model", zh: "依模型" },
  "dash.recent.title": { en: "Recent uploads", zh: "最近上傳" },
  "dash.activity.title": { en: "Recent model activity", zh: "最近模型活動" },

  // ----- Signature comparison -----
  "sig.enrollTitle": { en: "Enrol reference signatures", zh: "登記參考簽名" },
  "sig.enrollSub": {
    en: "Upload known-good signature specimens. Each is embedded with voyage-multimodal-3.5 (image embedding) and indexed for visual-similarity search.",
    zh: "上傳已知真確的簽名樣本。每個都會用 voyage-multimodal-3.5（圖片嵌入）建立向量並索引，供視覺相似度搜尋。",
  },
  "sig.signerName": { en: "Signer name", zh: "簽名人姓名" },
  "sig.signerPlaceholder": { en: "e.g. Peter Chan / 陳大文", zh: "例如：陳大文 / Peter Chan" },
  "sig.label": { en: "Label (optional)", zh: "標籤（選填）" },
  "sig.labelPlaceholder": { en: "e.g. 2023 tenancy agreement", zh: "例如：2023 租約" },
  "sig.dropSignature": { en: "Click or drop a signature image", zh: "按此或拖放簽名圖片" },
  "sig.enrollBtn": { en: "Enrol signature", zh: "登記簽名" },
  "sig.enrolling": { en: "Enrolling…", zh: "登記中…" },
  "sig.needFileAndName": {
    en: "Choose an image and enter the signer name.",
    zh: "請選擇圖片並輸入簽名人姓名。",
  },
  "sig.enrolled": { en: "Enrolled signature for {name}.", zh: "已登記 {name} 的簽名。" },
  "sig.enrolledMany": {
    en: "Enrolled {count} signatures.",
    zh: "已登記 {count} 個簽名。",
  },
  "sig.enrollAllBtn": {
    en: "Enrol {count} signatures",
    zh: "登記 {count} 個簽名",
  },
  "sig.multiEnrollHint": {
    en: "{count} signature regions detected. Name each one to enrol it as a separate specimen (leave blank to skip).",
    zh: "偵測到 {count} 個簽名區域。為每個區域命名以分別登記為獨立樣本（留空則略過）。",
  },
  "sig.needRegionNames": {
    en: "Enter a signer name for at least one region.",
    zh: "請至少為一個區域輸入簽名人姓名。",
  },
  "sig.nRegions": {
    en: "{count} regions detected",
    zh: "偵測到 {count} 個區域",
  },
  "sig.compareAllHint": {
    en: "{count} signature regions detected — Compare will match EACH region against the enrolled specimens and show the best match per region.",
    zh: "偵測到 {count} 個簽名區域 — 比對將以每個區域分別與已登記樣本比對，並顯示每個區域的最佳匹配。",
  },
  "sig.regionResultHead": {
    en: "Region {n} — best match",
    zh: "區域 {n} — 最佳匹配",
  },
  "sig.libraryTitle": { en: "Enrolled signatures ({n})", zh: "已登記簽名（{n}）" },
  "sig.emptyLibrary": {
    en: "No enrolled signatures yet. Enrol a few specimens above, then compare a query signature.",
    zh: "尚無已登記簽名。請先於上方登記一些樣本，再比對查詢簽名。",
  },
  "sig.compareTitle": { en: "Compare a signature", zh: "比對簽名" },
  "sig.compareSub": {
    en: "Upload a signature to verify. It's embedded and matched against enrolled specimens by cosine similarity; results are banded by confidence.",
    zh: "上傳要驗證的簽名。系統會建立嵌入並以 cosine 相似度比對已登記樣本，結果按信心分級。",
  },
  "sig.dropQuery": { en: "Click or drop the signature to verify", zh: "按此或拖放要驗證的簽名" },
  "sig.compareBtn": { en: "Compare signature", zh: "比對簽名" },
  "sig.comparing": { en: "Comparing…", zh: "比對中…" },
  "sig.results": { en: "Match results", zh: "比對結果" },
  "sig.noEnrolled": {
    en: "No enrolled signatures to compare against. Enrol some first.",
    zh: "沒有可比對的已登記簽名，請先登記。",
  },
  "sig.similarity": { en: "similarity", zh: "相似度" },
  "sig.band.match": { en: "MATCH", zh: "相符" },
  "sig.band.review": { en: "NEEDS REVIEW", zh: "需人工複核" },
  "sig.band.no_match": { en: "NO MATCH", zh: "不相符" },
  "sig.thresholds": {
    en: "Thresholds — match ≥ {match}, review ≥ {review}",
    zh: "閾值 — 相符 ≥ {match}，複核 ≥ {review}",
  },
  "sig.deleteConfirm": {
    en: "Delete this enrolled signature?",
    zh: "刪除此已登記簽名？",
  },
  "sig.queryPreview": { en: "Query signature", zh: "查詢簽名" },
  "sig.cropHint": {
    en: "Drag a box over the signature (not the whole page) for precise matching.",
    zh: "在簽名上（而非整頁）拖出方框，以作精準比對。",
  },
  "sig.autoDetect": { en: "✨ Auto-detect signature", zh: "✨ 自動偵測簽名" },
  "sig.detecting": { en: "Detecting…", zh: "偵測中…" },
  "sig.clearCrop": { en: "Clear box", zh: "清除方框" },
  "sig.noRegion": {
    en: "No signature region detected — draw one manually.",
    zh: "未偵測到簽名區域 — 請手動框選。",
  },
  "sig.multiRegion": {
    en: "Detected {count} signature regions — pick which one to use below.",
    zh: "偵測到 {count} 個簽名區域 — 請於下方選擇要使用的一個。",
  },
  "sig.chooseRegion": {
    en: "{count} signatures found — choose a region:",
    zh: "找到 {count} 個簽名 — 請選擇區域：",
  },
  "sig.regionN": { en: "Region {n}", zh: "區域 {n}" },
  "sig.wholeImageWarn": {
    en: "No box selected: the WHOLE image will be embedded (less precise).",
    zh: "未框選：將以整張圖片建立嵌入（精準度較低）。",
  },
  "sig.cropped": { en: "region selected", zh: "已框選區域" },
  "sig.cropRequired": {
    en: "Draw (or auto-detect) a box over the signature first — enrolled signatures are cropped, so a whole-page compare is inaccurate.",
    zh: "請先框選（或自動偵測）簽名區域 — 已登記的簽名是裁剪過的，整頁比對並不準確。",
  },
  "sig.embeddedRegion": {
    en: "This exact region will be embedded & matched:",
    zh: "將以此區域建立嵌入並比對：",
  },
  "sig.boxAdjusted": {
    en: "Signature box adjusted — run compare again to re-embed this region and refresh results.",
    zh: "已調整簽名框 — 請再次比對以重新嵌入此區域並更新結果。",
  },
  "sig.confirmCompare": {
    en: "Compare using the currently boxed region? The signature area will be cropped and embedded, then matched against enrolled signatures.",
    zh: "以目前框選的區域進行比對？系統會裁剪並嵌入此簽名區域，再與已登記簽名比對。",
  },
  "sig.reCompare": { en: "Re-compare with this box", zh: "以此框重新比對" },
  "sig.confirmYes": { en: "Yes, compare", zh: "確認比對" },
  "sig.autoDetectUnreliableHint": {
    en: "Auto-detect is best-effort. If the box isn't on the signature, drag to redraw it, then compare.",
    zh: "自動偵測僅供參考。若方框不在簽名上，請拖曳重畫，再進行比對。",
  },
  "sig.embeddedRegionTag": { en: "embedded region", zh: "嵌入區域" },
  "sig.viewerOriginal": {
    en: "Original signature (box = embedded region)",
    zh: "原始簽名（方框＝嵌入區域）",
  },
  "sig.viewerEmbedded": {
    en: "Exactly what was embedded & matched",
    zh: "實際嵌入並比對的內容",
  },
  "sig.clickEnlarge": {
    en: "Click to enlarge (shows the boxed signature region)",
    zh: "按此放大（顯示框選的簽名區域）",
  },
  "sig.mechanismTitle": { en: "How signature matching works", zh: "簽名比對運作方式" },
  "sig.step1.title": { en: "1 · Image recognition", zh: "1 · 影像辨識" },
  "sig.step1.body": {
    en: "The page image is sent to a vision model that reads the layout and locates the handwritten signature.",
    zh: "將整頁圖片送往視覺模型，讀取版面並定位手寫簽名。",
  },
  "sig.step2.title": { en: "2 · Box the signature", zh: "2 · 框選簽名" },
  "sig.step2.body": {
    en: "The model returns a bounding box around the signature strokes. You can adjust or redraw it.",
    zh: "模型回傳簽名筆跡的邊界框，你可調整或重畫。",
  },
  "sig.step3.title": { en: "3 · Crop & embed", zh: "3 · 裁剪並嵌入" },
  "sig.step3.body": {
    en: "Only that cropped region is embedded with voyage-multimodal-3.5 into a 1024-d vector.",
    zh: "只將裁剪後的區域用 voyage-multimodal-3.5 建立 1024 維向量。",
  },
  "sig.step4.title": { en: "4 · Cosine match", zh: "4 · Cosine 比對" },
  "sig.step4.body": {
    en: "Matching compares signature-region vectors by cosine similarity — identical printed pages no longer look alike, only the signatures are compared.",
    zh: "以 cosine 相似度比較「簽名區域」向量 — 即使印刷版面相同也不會誤判，只比對簽名本身。",
  },
  "sig.viewProcess": { en: "View process", zh: "檢視流程" },
  "sig.processTitle": { en: "Auto-detect process", zh: "自動偵測流程" },
  "sig.processSub": {
    en: "Step-by-step trace of how the signature region was located.",
    zh: "定位簽名區域的逐步流程記錄。",
  },
  "sig.rawResponse": { en: "Model output", zh: "模型輸出" },
  // Process-dialog step titles + notes (translated on the frontend from keys).
  "sig.proc.checkModel": { en: "Check vision model", zh: "檢查視覺模型" },
  "sig.proc.noModel": {
    en: "No vision LLM configured (LLM_API_KEY unset).",
    zh: "未設定視覺 LLM（LLM_API_KEY 未設定）。",
  },
  "sig.proc.prepare": { en: "Prepare image", zh: "準備圖片" },
  "sig.proc.prepareNote": {
    en: "{mime}, {kb} KB → base64 data URI (detail: high)",
    zh: "{mime}，{kb} KB → base64 資料 URI（detail: high）",
  },
  "sig.proc.locate": { en: "Vision model locates signature", zh: "視覺模型定位簽名" },
  "sig.proc.locateNote": {
    en: "Model {model} returned a response.",
    zh: "模型 {model} 已回傳結果。",
  },
  "sig.proc.apiErr": {
    en: "Vision API error {status} ({model}).",
    zh: "視覺 API 錯誤 {status}（{model}）。",
  },
  "sig.proc.callFailed": { en: "Call failed: {msg}", zh: "呼叫失敗：{msg}" },
  "sig.proc.parse": { en: "Parse bounding box", zh: "解析邊界框" },
  "sig.proc.noJson": {
    en: "No JSON found in model output.",
    zh: "模型輸出中找不到 JSON。",
  },
  "sig.proc.noneFound": {
    en: "Model reported no handwritten signature.",
    zh: "模型回報沒有手寫簽名。",
  },
  "sig.proc.badBox": {
    en: "Bounding box was not valid numbers.",
    zh: "邊界框數值無效。",
  },
  "sig.proc.boxNote": {
    en: "Box x:{x} y:{y} w:{w} h:{h} (fractions of the page).",
    zh: "邊界框 x:{x} y:{y} w:{w} h:{h}（相對整頁的比例）。",
  },
  "sig.proc.boxesNote": {
    en: "Found {count} signature region(s).",
    zh: "找到 {count} 個簽名區域。",
  },
  "sig.proc.cache": {
    en: "Check detection cache",
    zh: "檢查偵測快取",
  },
  "sig.proc.cacheHit": {
    en: "Returned {count} previously stabilised region(s) for this exact image.",
    zh: "此圖片先前已穩定化，直接返回 {count} 個區域。",
  },
  "sig.proc.cacheMiss": {
    en: "No cached result; running the vision model.",
    zh: "沒有快取結果；正在執行視覺模型。",
  },
  "sig.proc.parseFailed": {
    en: "Failed to parse model JSON.",
    zh: "無法解析模型 JSON。",
  },
  "sig.proc.embed": { en: "Crop → embed (on enrol/compare)", zh: "裁剪 → 嵌入（登記／比對時）" },
  "sig.proc.embedNote": {
    en: "Only this region is cropped and embedded with {model} into a 1024-d vector.",
    zh: "只將此區域裁剪並用 {model} 建立 1024 維向量。",
  },
  // Live progress phases shown while auto-detect runs.
  "sig.phase.prepare": { en: "Preparing image", zh: "準備圖片" },
  "sig.phase.upload": { en: "Sending to vision model", zh: "傳送至視覺模型" },
  "sig.phase.locate": {
    en: "Vision model locating signature",
    zh: "視覺模型定位簽名中",
  },
  "sig.phase.parse": { en: "Parsing bounding box", zh: "解析邊界框" },
  "sig.phase.done": { en: "Cropping & embedding", zh: "裁剪並嵌入" },
  "sig.elapsed": { en: "elapsed {s}s", zh: "已用 {s} 秒" },
  "sig.detectingHint": {
    en: "This can take up to a minute — the vision model reads the full page to find the signature.",
    zh: "可能需時最多一分鐘 — 視覺模型需讀取整頁以尋找簽名。",
  },

  // ----- Chat / conversational RAG -----
  "chat.newConversation": { en: "New conversation", zh: "新對話" },
  "chat.noConversations": { en: "No conversations yet.", zh: "尚無對話。" },
  "chat.noMatches": { en: "No matching conversations.", zh: "沒有符合的對話。" },
  "chat.searchConversations": {
    en: "Search conversations…",
    zh: "搜尋對話…",
  },
  "chat.rename": { en: "Rename", zh: "重新命名" },
  "chat.turns": { en: "{n} turns", zh: "{n} 則訊息" },
  // Live "thinking" phases while the answer is generated.
  "chat.phase.store": { en: "Saving your turn to memory", zh: "將你的訊息存入記憶" },
  "chat.phase.recall": {
    en: "Recalling relevant past turns",
    zh: "喚回相關的過往內容",
  },
  "chat.phase.retrieve": {
    en: "Retrieving grounding from documents",
    zh: "從文件檢索依據",
  },
  "chat.phase.generate": {
    en: "Generating grounded answer",
    zh: "生成有依據的回覆",
  },
  "chat.empty": {
    en: "Start a conversation. Ask a question, then keep asking follow-ups — the assistant remembers the thread and recalls relevant earlier turns from memory.",
    zh: "開始對話。先問一個問題，再繼續追問 — 助理會記住對話脈絡，並從記憶中喚回相關的過往內容。",
  },
  "chat.placeholder": {
    en: "Ask a follow-up… (⌘/Ctrl+Enter to send)",
    zh: "輸入追問…（⌘/Ctrl+Enter 傳送）",
  },
  "chat.send": { en: "Send", zh: "傳送" },
  "chat.steps": { en: "Pipeline steps ({n})", zh: "處理步驟（{n}）" },
  "chat.recalledMemory": {
    en: "Memory · {n} recalled",
    zh: "記憶 · 喚回 {n} 則",
  },
  "chat.sources": { en: "Source evidence ({n})", zh: "來源依據（{n}）" },
  "chat.recallAll": {
    en: "Recall across all conversations",
    zh: "跨所有對話喚回記憶",
  },
  "chat.recallAllTitle": {
    en: "Also search memory from OTHER conversations, not just this thread",
    zh: "亦搜尋其他對話的記憶，而非只限本次對話",
  },
  "chat.deleteConfirm": {
    en: "Delete this conversation and all its messages from memory?",
    zh: "刪除此對話及其在記憶中的所有訊息？",
  },
  "tab.documents": { en: "Upload & Review", zh: "上傳與審核" },
  "tab.policies": { en: "Knowledge Policies", zh: "知識政策" },
  "tab.corrections": { en: "Human Corrections (legacy)", zh: "人工修正（舊版）" },

  // ----- Compare modes -----
  "mode.vector.name": { en: "Vector only", zh: "僅向量" },
  "mode.vector.sub": { en: "semantic · $vectorSearch", zh: "語意 · $vectorSearch" },
  "mode.hybrid.name": { en: "Hybrid Search", zh: "混合搜尋" },
  "mode.hybrid.sub": {
    en: "$rankFusion · Vector + Atlas Search",
    zh: "$rankFusion · 向量 + Atlas 搜尋",
  },
  "mode.rerank.name": { en: "Vector + Reranker", zh: "向量 + 重新排序" },
  "mode.rerank.sub": {
    en: "candidate pool · Voyage rerank",
    zh: "候選集 · Voyage 重新排序",
  },

  // ----- Model comparison -----
  "modelcmp.primary.name": {
    en: "voyage-4 (Atlas auto)",
    zh: "voyage-4（Atlas 自動）",
  },
  "modelcmp.primary.sub": {
    en: "primary · $vectorSearch",
    zh: "主要 · $vectorSearch",
  },
  "modelcmp.mm.name": { en: "voyage-multimodal-3.5", zh: "voyage-multimodal-3.5" },
  "modelcmp.mm.sub": {
    en: "multimodal · $vectorSearch",
    zh: "多模態 · $vectorSearch",
  },
  "modelcmp.notice": {
    en: "Embedding model comparison. Same $vectorSearch, same query — only the embedding model differs. Left: {primary} (primary Atlas auto-embedding, index vector_index). Right: voyage-multimodal-3.5 (explicit vectors, index vector_index_mm). Compare which model ranks the right facts higher.",
    zh: "嵌入模型比較。相同的 $vectorSearch、相同的查詢 — 只有嵌入模型不同。左：{primary}（主要 Atlas 自動嵌入，索引 vector_index）。右：voyage-multimodal-3.5（明確向量，索引 vector_index_mm）。比較哪個模型能把正確資訊排得更前。",
  },
  "modelcmp.runToCompare": {
    en: "Run a query to compare models.",
    zh: "輸入查詢以比較模型。",
  },

  // ----- Common states / buttons -----
  "common.runToCompare": { en: "Run a query to compare.", zh: "輸入查詢以比較。" },
  "compare.generateAnswer": {
    en: "✦ Generate answer from these results",
    zh: "✦ 依這些結果生成回覆",
  },
  "compare.generateTitle": {
    en: "Send these retrieved candidates straight to the LLM — no re-retrieval",
    zh: "將這些已檢索的候選內容直接送交 LLM — 不重新檢索",
  },
  "compare.generating": {
    en: "Generating from these candidates…",
    zh: "正依這些候選內容生成…",
  },
  "compare.answerFrom": {
    en: "Answer grounded on {mode} candidates",
    zh: "以 {mode} 候選內容為依據的回覆",
  },
  "compare.reused": {
    en: "reused candidates · no re-retrieval",
    zh: "重用候選內容 · 未重新檢索",
  },
  "common.retrieving": { en: "Retrieving…", zh: "檢索中…" },
  "common.noResults": { en: "No results.", zh: "沒有結果。" },
  "common.loading": { en: "Loading…", zh: "載入中…" },
  "common.showQuery": { en: "</> Show query", zh: "</> 顯示查詢" },
  "common.ms": { en: "{n} ms", zh: "{n} 毫秒" },
  "common.modelsUsed": { en: "Models:", zh: "使用模型：" },
  "common.close": { en: "Close", zh: "關閉" },
  "common.cancel": { en: "Cancel", zh: "取消" },
  "common.download": { en: "Download", zh: "下載" },
  "common.copy": { en: "Copy", zh: "複製" },
  "common.copied": { en: "Copied", zh: "已複製" },
  "common.delete": { en: "Delete", zh: "刪除" },
  "common.save": { en: "Save", zh: "儲存" },
  "common.enable": { en: "Enable", zh: "啟用" },
  "common.disable": { en: "Disable", zh: "停用" },

  // ----- Compare notices -----
  "compare.aliasExpansion": { en: "Alias expansion:", zh: "別名擴展：" },
  "compare.aliasEnriched": {
    en: "query enriched with",
    zh: "查詢已擴充：",
  },
  "compare.correctionsApplied": {
    en: "Human corrections applied:",
    zh: "已套用人工修正：",
  },

  // ----- RAG -----
  "rag.empty": {
    en: "Ask a question and click Answer to generate a grounded response with cited sources.",
    zh: "輸入問題並按「回答」，以產生附引用來源的有依據回覆。",
  },
  "rag.generating": {
    en: "Retrieving context and generating a grounded answer…",
    zh: "正在檢索內容並產生有依據的回覆…",
  },
  "rag.groundedAnswer": { en: "Grounded answer", zh: "有依據的回覆" },
  "rag.contextVia": { en: "context via {mode}", zh: "內容來自 {mode}" },
  "rag.llm": { en: "LLM", zh: "大型語言模型" },
  "rag.extractive": { en: "extractive", zh: "擷取式" },
  "rag.showPipeline": {
    en: "</> Show pipeline & features",
    zh: "</> 顯示管線與功能",
  },
  "rag.sources": { en: "Sources", zh: "來源" },
  "rag.sourceEvidence": {
    en: "Source evidence ({n} chunks)",
    zh: "來源依據（{n} 個片段）",
  },
  "rag.correctInterpretation": {
    en: "⚑ Correct an interpretation",
    zh: "⚑ 修正解讀",
  },
  "rag.correctInterpretationTitle": {
    en: "Correct an interpretation at the data layer (no prompt editing)",
    zh: "在資料層修正解讀（無需編輯提示詞）",
  },
  "rag.aliasExpansion": { en: "Alias expansion:", zh: "別名擴展：" },
  "rag.correctionsApplied": { en: "Corrections applied:", zh: "已套用修正：" },
  "footnote": {
    en: "MongoDB Atlas · Voyage embeddings & reranker · Next.js · Property management operations demo. All property names and content are synthetic.",
    zh: "MongoDB Atlas · Voyage 嵌入與重新排序 · Next.js · 物業管理營運示範。所有物業名稱與內容均為虛構。",
  },
  "modal.explainHowItWorks": {
    en: "{title} — how it works",
    zh: "{title} — 運作方式",
  },
  "modal.explainSubtitle": {
    en: "MongoDB features used and the exact aggregation pipeline(s) executed for this result.",
    zh: "此結果所使用的 MongoDB 功能，以及實際執行的聚合管線。",
  },
  "modal.featuresUsed": {
    en: "MongoDB / Atlas features used",
    zh: "使用的 MongoDB / Atlas 功能",
  },
  "modal.queryExecuted": { en: "Actual query executed", zh: "實際執行的查詢" },
  "modal.notes": { en: "Notes", zh: "備註" },
  "modal.schemaTitle2": {
    en: "Data schema (behind the scenes)",
    zh: "資料綱要（幕後）",
  },
  "modal.schemaSub2": {
    en: "The chunk document shape, Atlas index definitions, and a live sample document from your Atlas collection.",
    zh: "片段文件結構、Atlas 索引定義，以及來自您 Atlas 集合的即時範例文件。",
  },
  "modal.loadingSchema": { en: "Loading schema…", zh: "載入綱要中…" },
  "modal.collections": { en: "Collections", zh: "集合" },
  "modal.chunkSchema": { en: "Chunk JSON Schema", zh: "片段 JSON 綱要" },
  "modal.indexDefs": { en: "Atlas index definitions", zh: "Atlas 索引定義" },
  "modal.liveSample": { en: "Live sample document", zh: "即時範例文件" },
  "modal.vectorIndex": {
    en: "Vector Search index: {name}",
    zh: "向量搜尋索引：{name}",
  },
  "modal.lexicalIndex": {
    en: "Atlas Search (lexical) index: {name}",
    zh: "Atlas 搜尋（詞彙）索引：{name}",
  },

  // ----- Explain / Schema modals -----
  "modal.explainTitle": { en: "How this works", zh: "運作方式" },
  "modal.mongoFeatures": { en: "MongoDB features used", zh: "使用的 MongoDB 功能" },
  "modal.pipeline": { en: "Executed pipeline", zh: "執行的管線" },
  "modal.schemaTitle": { en: "Data schema", zh: "資料綱要" },
  "modal.schemaSub": {
    en: "Collections, fields, and index definitions backing this demo.",
    zh: "支撐此示範的集合、欄位與索引定義。",
  },

  // ----- Documents tab -----
  "docs.uploadTitle": { en: "Upload & ingest a document", zh: "上傳並匯入文件" },
  "docs.uploadSub": {
    en: "PDF · DOCX · Excel/CSV · PPTX · images. Text is extracted (OCR + an LLM vision pass for scanned/handwritten content), chunked, alias-enriched, and written to Atlas with full source-to-chunk traceability.",
    zh: "PDF · DOCX · Excel/CSV · PPTX · 圖片。系統會擷取文字（OCR + 針對掃描／手寫內容的 LLM 視覺處理），切分片段、擴充別名，並寫入 Atlas，保留完整的來源到片段追溯。",
  },
  "docs.dropReplace": {
    en: "{size} KB · click to replace",
    zh: "{size} KB · 按此更換",
  },
  "docs.dropPrompt": { en: "Click or drop a file", zh: "按此或拖放檔案" },
  "docs.dropToIngest": { en: "to ingest", zh: "以匯入" },
  "docs.dropTypes": {
    en: "PDF, DOCX, XLSX/CSV, PPTX, PNG/JPG, TXT",
    zh: "PDF、DOCX、XLSX/CSV、PPTX、PNG/JPG、TXT",
  },
  "docs.title": { en: "Title", zh: "標題" },
  "docs.titlePlaceholder": {
    en: "e.g. ICC Chiller Plant O&M Manual",
    zh: "例如：ICC 冷水機房運維手冊",
  },
  "docs.docType": { en: "Document type", zh: "文件類型" },
  "docs.propertyName": { en: "Property name", zh: "物業名稱" },
  "docs.versionLabel": { en: "Version label", zh: "版本標籤" },
  "docs.effectiveFrom": { en: "Effective from", zh: "生效日期" },
  "docs.tags": { en: "Tags", zh: "標籤" },
  "docs.exactTerms": { en: "Exact terms", zh: "精確詞彙" },
  "docs.versionGroupId": { en: "Version group ID", zh: "版本群組 ID" },
  "docs.uploadBtn": { en: "Upload & ingest", zh: "上傳並匯入" },
  "docs.uploading": { en: "Uploading…", zh: "上傳中…" },
  "docs.chooseFirst": { en: "Choose a file first.", zh: "請先選擇檔案。" },
  "docs.historyTitle": { en: "Processing history", zh: "處理歷史" },
  "docs.historySub": {
    en: "Every document's ingestion trace, kept after upload — expand any row to see the real per-step pipeline timings.",
    zh: "每份文件的匯入處理軌跡，上傳後持續保留 — 展開任一列即可查看各步驟的實際耗時。",
  },
  "docs.historyEmpty": {
    en: "No ingestion history yet for this demo. Upload a document to see its processing trace here.",
    zh: "此展示尚無匯入歷史。上傳文件後即可在此查看處理軌跡。",
  },
  "docs.libraryTitle": { en: "Document library ({n})", zh: "文件庫（{n}）" },
  "docs.librarySub": {
    en: "Reviewable view of every ingested document — file type, OCR, chunk count, embedding + version status, and human review state.",
    zh: "每份已匯入文件的可審核檢視 — 檔案類型、OCR、片段數、嵌入與版本狀態，以及人工審核狀態。",
  },
  "docs.emptyLibrary": {
    en: "No uploaded documents yet. Upload one above, or run npm run seed for the sample corpus.",
    zh: "尚無已上傳的文件。請於上方上傳，或執行 npm run seed 載入範例語料。",
  },
  "docs.col.title": { en: "Title", zh: "標題" },
  "docs.col.type": { en: "Type", zh: "類型" },
  "docs.col.property": { en: "Property", zh: "物業" },
  "docs.col.file": { en: "File", zh: "檔案" },
  "docs.col.chunks": { en: "Chunks", zh: "片段" },
  "docs.col.version": { en: "Version", zh: "版本" },
  "docs.col.status": { en: "Status", zh: "狀態" },
  "docs.col.review": { en: "Review", zh: "審核" },
  "docs.col.signature": { en: "Signature", zh: "簽署" },
  "docs.sig.pending": { en: "⋯ Analysing", zh: "⋯ 分析中" },
  "docs.sig.signed": { en: "✓ Signed", zh: "✓ 已簽署" },
  "docs.sig.unsigned": { en: "⚠ Unsigned", zh: "⚠ 未簽署" },
  "docs.sig.not_required": { en: "Not required", zh: "無需簽署" },
  "docs.sig.unknown": { en: "? Unknown", zh: "? 未知" },
  "docs.review": { en: "Review", zh: "審核" },
  "docs.preview": { en: "⛶ Preview", zh: "⛶ 預覽" },
  "docs.deleteTitle": {
    en: "Delete this document and all of its backend data",
    zh: "刪除此文件及其所有後端資料",
  },
  "docs.reindex": { en: "Re-OCR", zh: "重新識別" },
  "docs.reindexing": { en: "Re-OCR…", zh: "重新識別中…" },
  "docs.reindexTitle": {
    en: "Re-extract text + re-embed from the original using the current OCR engine (fixes stale/low-quality extractions)",
    zh: "以目前的 OCR 引擎從原始檔重新擷取文字並重新嵌入（修正舊有或低品質的識別結果）",
  },
  "docs.reindexConfirm": {
    en: "Re-OCR and re-embed {label} from the original file using the current OCR engine? This replaces the existing extracted text and embeddings.",
    zh: "以目前的 OCR 引擎從原始檔重新識別並重新嵌入 {label}？這會取代現有的擷取文字與嵌入。",
  },
  "docs.reindexed": {
    en: "Re-indexed {label} — {method}, {chunks} chunks.",
    zh: "已重新索引 {label} — {method}，{chunks} 個片段。",
  },
  "docs.reindexFailed": { en: "Re-index failed.", zh: "重新索引失敗。" },
  "docs.deleteConfirm": {
    en: 'Delete {label}?\n\nThis permanently removes the document, all of its chunks, and the stored original file from the backend. This cannot be undone.',
    zh: "刪除 {label}？\n\n此操作會永久移除該文件、其所有片段，以及後端儲存的原始檔案，且無法復原。",
  },
  "docs.deleteFailed": {
    en: "Delete failed (HTTP {status}).",
    zh: "刪除失敗（HTTP {status}）。",
  },
  "docs.deleted": {
    en: "Deleted {label} and its backend data.",
    zh: "已刪除 {label} 及其後端資料。",
  },
  "docs.ingested": {
    en: 'Ingested "{title}" — {chunks} chunks, {ocr}, status: {status}.',
    zh: "已匯入「{title}」 — {chunks} 個片段，{ocr}，狀態：{status}。",
  },
  "docs.ocrUsed": { en: "OCR used", zh: "已使用 OCR" },
  "docs.noOcr": { en: "no OCR", zh: "未使用 OCR" },
  "docs.reviewTitle": { en: "Review · {title}", zh: "審核 · {title}" },
  "docs.approve": { en: "Approve", zh: "核准" },
  "docs.needsCorrection": { en: "Needs correction", zh: "需要修正" },
  "docs.markObsolete": { en: "Mark obsolete", zh: "標記為已淘汰" },
  "docs.unmarkObsolete": { en: "Un-mark obsolete", zh: "取消已淘汰標記" },
  "docs.extractedPreview": { en: "Extracted text preview", zh: "擷取文字預覽" },
  "docs.noText": { en: "(no text extracted)", zh: "（未擷取到文字）" },
  "docs.actualContent": { en: "Actual file content", zh: "實際檔案內容" },
  "docs.previewFullscreen": {
    en: "⛶ Preview content (fullscreen)",
    zh: "⛶ 預覽內容（全螢幕）",
  },
  "docs.downloadOriginal": { en: "Download original", zh: "下載原始檔案" },
  "docs.noOriginal": {
    en: "no original file stored (seed data / pre-upgrade upload)",
    zh: "未儲存原始檔案（種子資料／升級前上傳）",
  },

  // ----- File preview dialog -----
  "preview.title": { en: "File preview", zh: "檔案預覽" },
  "preview.loading": { en: "Loading preview…", zh: "載入預覽中…" },
  "preview.cannotRender": {
    en: "Can't render this file type inline. Download it to view.",
    zh: "無法內嵌顯示此檔案類型，請下載後檢視。",
  },
  "preview.failed": { en: "Failed to load preview.", zh: "載入預覽失敗。" },
  "preview.jumpedToPassage": {
    en: "Jumped to the exact retrieved passage (highlighted below).",
    zh: "已跳至檢索到的段落（下方以高亮標示）。",
  },
  "preview.passageNotFound": {
    en: "Couldn't pinpoint the exact passage in the source — showing the full document.",
    zh: "無法在來源中精確定位該段落 — 顯示完整文件。",
  },
  "preview.retrievedPassage": {
    en: "Retrieved passage",
    zh: "檢索到的段落",
  },

  // ----- Policies tab -----
  "pol.title": { en: "Knowledge Policy Layer", zh: "知識政策層" },
  "pol.step1": { en: "1 · Submit feedback", zh: "1 · 提交回饋" },
  "pol.step2": { en: "2 · Review proposals", zh: "2 · 審核提案" },
  "pol.step3": { en: "3 · Active policies", zh: "3 · 生效政策" },
  "pol.submitFeedback": {
    en: "Submit feedback → draft proposal",
    zh: "提交回饋 → 草擬提案",
  },
  "pol.approve": { en: "Approve", zh: "核准" },
  "pol.reject": { en: "Reject", zh: "拒絕" },
  "pol.deactivate": { en: "Deactivate", zh: "停用" },
  "pol.feedbackType": { en: "Feedback type", zh: "回饋類型" },
  "pol.emptyProposals": {
    en: "No proposals yet.",
    zh: "尚無提案。",
  },
  "pol.emptyPolicies": {
    en: "No active policies yet.",
    zh: "尚無生效政策。",
  },

  // ----- Corrections tab -----
  "corr.title": { en: "Human Corrections", zh: "人工修正" },
  "corr.save": { en: "Save correction", zh: "儲存修正" },
  "corr.type": { en: "Correction type", zh: "修正類型" },
  "corr.empty": { en: "No corrections yet.", zh: "尚無修正。" },

  // ----- ResultCard -----
  "card.obsolete": { en: "obsolete", zh: "已淘汰" },
  "card.ocr": { en: "OCR", zh: "OCR" },
  "card.previewType": { en: "⛶ Preview {type}", zh: "⛶ 預覽 {type}" },
  "card.viewDoc": { en: "View MongoDB document", zh: "檢視 MongoDB 文件" },

  // ----- Document (chunk) JSON modal -----
  "docModal.title": { en: "MongoDB document", zh: "MongoDB 文件" },
  "docModal.subtitle": {
    en: "The actual document stored in the {collection} collection.",
    zh: "儲存於 {collection} 集合中的實際文件。",
  },
  "docModal.loading": { en: "Loading document…", zh: "正在載入文件…" },
  "docModal.meta": {
    en: "db.{collection}.findOne({ _id: \"{id}\" })",
    zh: "db.{collection}.findOne({ _id: \"{id}\" })",
  },
};

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  // Load persisted choice on mount.
  useEffect(() => {
    const saved = (typeof window !== "undefined" &&
      window.localStorage.getItem("lang")) as Lang | null;
    if (saved === "en" || saved === "zh") setLangState(saved);
  }, []);

  // Reflect the language on <html lang> and persist.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-Hant" : "en";
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("lang", lang);
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const entry = DICT[key];
      let str = entry ? entry[lang] : key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return str;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Safe fallback so components can be used outside the provider in tests.
    return {
      lang: "en",
      setLang: () => {},
      t: (key: string, vars?: Record<string, string | number>) => {
        const entry = DICT[key];
        let str = entry ? entry.en : key;
        if (vars)
          for (const [k, v] of Object.entries(vars))
            str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        return str;
      },
    };
  }
  return ctx;
}
