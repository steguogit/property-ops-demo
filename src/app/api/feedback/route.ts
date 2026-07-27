import { NextRequest, NextResponse } from "next/server";
import { addFeedback, listFeedback } from "@/lib/policies";
import { generateProposalsFromFeedback } from "@/lib/proposal-engine";
import { detectAndRecordForProposal } from "@/lib/conflict-detection";
import { FeedbackType } from "@/lib/mongo";

export const dynamic = "force-dynamic";

const VALID: FeedbackType[] = [
  "wrong_term_interpretation",
  "missing_document",
  "wrong_document_rank",
  "outdated_document",
  "source_should_be_boosted",
  "source_should_be_demoted",
  "incorrect_answer",
  "other",
];

export async function GET() {
  try {
    const feedback = await listFeedback();
    return NextResponse.json({ feedback });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, feedback: [] },
      { status: 500 }
    );
  }
}

/**
 * Submit feedback. By default this also runs the AI-assisted proposal engine
 * and conflict detection (advisory) — but NEVER activates a policy. Pass
 * `generateProposal:false` to only store the raw feedback.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!VALID.includes(body.feedbackType)) {
      return NextResponse.json(
        { error: `feedbackType must be one of ${VALID.join(", ")}` },
        { status: 400 }
      );
    }
    const feedback = await addFeedback({
      tenantId: body.tenantId,
      propertyId: body.propertyId ?? null,
      department: body.department ?? null,
      userId: body.userId ?? "anonymous",
      conversationId: body.conversationId ?? null,
      queryText: body.queryText ?? "",
      answerText: body.answerText ?? null,
      retrievedDocumentIds: body.retrievedDocumentIds ?? null,
      feedbackType: body.feedbackType,
      feedbackText: body.feedbackText ?? "",
      language: body.language ?? null,
    });

    let proposals = undefined;
    let conflicts = undefined;
    if (body.generateProposal !== false) {
      proposals = await generateProposalsFromFeedback(feedback, {
        useLlm: body.useLlm,
      });
      conflicts = [];
      for (const p of proposals) {
        const c = await detectAndRecordForProposal(p);
        conflicts.push(...c);
      }
    }

    return NextResponse.json({ feedback, proposals, conflicts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
