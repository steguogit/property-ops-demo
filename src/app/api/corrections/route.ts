import { NextRequest, NextResponse } from "next/server";
import {
  addCorrection,
  listCorrections,
  setCorrectionActive,
} from "@/lib/corrections";
import { CorrectionType } from "@/lib/mongo";

export const dynamic = "force-dynamic";

const VALID: CorrectionType[] = [
  "term_meaning",
  "wrong_interpretation",
  "prefer_source",
  "demote_source",
  "prefer_version",
];

export async function GET() {
  try {
    const corrections = await listCorrections();
    return NextResponse.json({ corrections });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, corrections: [] },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const type = body.type as CorrectionType;
    if (!VALID.includes(type)) {
      return NextResponse.json(
        { error: `type must be one of ${VALID.join(", ")}` },
        { status: 400 }
      );
    }
    const correction = await addCorrection({
      type,
      query: body.query,
      term: body.term,
      correctedMeaning: body.correctedMeaning,
      propertyName: body.propertyName,
      targetDocId: body.targetDocId,
      preferredVersionLabel: body.preferredVersionLabel,
      note: body.note,
      createdBy: body.createdBy ?? "reviewer",
    });
    return NextResponse.json({ correction });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.correctionId) {
      return NextResponse.json(
        { error: "correctionId required" },
        { status: 400 }
      );
    }
    await setCorrectionActive(body.correctionId, body.active !== false);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
