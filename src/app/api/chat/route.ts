import { NextRequest, NextResponse } from "next/server";
import { chatRag } from "@/lib/rag";
import { createConversation, generateConversationTitle } from "@/lib/memory";
import { explainForMode } from "@/lib/explain";
import { modelsForMode } from "@/lib/models";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Send one turn in a conversation. If no conversationId is supplied a new
 * conversation is created (titled from the first question). Returns the grounded
 * answer, sources, recalled memory, and the (possibly new) conversationId.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query: string = (body.query ?? "").trim();
    const limit: number = body.limit ?? 6;
    const includeObsolete: boolean = body.includeObsolete ?? false;
    const recallFromAllConversations: boolean =
      body.recallFromAllConversations ?? false;
    const datasetId: string | undefined =
      typeof body.datasetId === "string" && body.datasetId
        ? body.datasetId
        : body.metadataType === "fsi"
        ? "fsi"
        : "property";
    let conversationId: string = body.conversationId ?? "";

    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    // Auto-create a thread on the first turn with a provisional title.
    let isNewConversation = false;
    if (!conversationId) {
      const conv = await createConversation(
        query.length > 48 ? query.slice(0, 45) + "…" : query
      );
      conversationId = conv.conversationId;
      isNewConversation = true;
    }

    const result = await chatRag(conversationId, query, limit, {
      includeObsolete,
      recallFromAllConversations,
      datasetId,
    });

    // Generate a concise topic TITLE from the content on the first turn — async,
    // so it never blocks the answer. The client polls the conversation list.
    if (isNewConversation) {
      void generateConversationTitle(conversationId);
    }

    const explain = explainForMode("rag", query, limit, { includeObsolete });
    return NextResponse.json({
      query,
      ...result,
      explain,
      models: modelsForMode("rag"),
      isNewConversation,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
