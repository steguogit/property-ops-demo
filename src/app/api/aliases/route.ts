import { NextResponse } from "next/server";
import { getAllAliases } from "@/lib/aliases";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const aliases = await getAllAliases();
    return NextResponse.json({ aliases });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, aliases: [] },
      { status: 500 }
    );
  }
}
