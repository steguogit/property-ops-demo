import { NextRequest, NextResponse } from "next/server";
import {
  getConversation,
  getMessages,
  deleteConversation,
  renameConversation,
} from "@/lib/memory";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const conversation = await getConversation(params.id);
    if (!conversation) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const messages = await getMessages(params.id);
    return NextResponse.json({ conversation, messages });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json().catch(() => ({}));
    const title = (body.title ?? "").toString();
    if (!title.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    await renameConversation(params.id, title);
    const conversation = await getConversation(params.id);
    return NextResponse.json({ conversation });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await deleteConversation(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
