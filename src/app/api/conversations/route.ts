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
    const conversations = q.trim()
      ? await searchConversations(q)
      : await listConversations();
    return NextResponse.json({ conversations });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const conv = await createConversation(body.title);
    return NextResponse.json({ conversation: conv });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
