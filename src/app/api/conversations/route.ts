import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  createConversation,
  searchConversations,
} from "@/lib/memory";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    const datasetId = req.nextUrl.searchParams.get("datasetId") || undefined;
    const conversations = q.trim()
      ? await searchConversations(q, 50, datasetId)
      : await listConversations(50, datasetId);
    return NextResponse.json({ conversations });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const conv = await createConversation(body.title, {
      datasetId: body.datasetId,
    });
    return NextResponse.json({ conversation: conv });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
