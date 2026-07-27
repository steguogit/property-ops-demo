import { NextRequest, NextResponse } from "next/server";
import {
  listProposals,
  getProposal,
  updateProposal,
  rejectProposal,
  approveProposalToPolicy,
} from "@/lib/policies";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get("status") as
      | import("@/lib/mongo").ProposalStatus
      | null;
    const proposals = await listProposals(undefined, status ?? undefined);
    return NextResponse.json({ proposals });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, proposals: [] },
      { status: 500 }
    );
  }
}

/**
 * Reviewer actions on a proposal:
 *   { action: "approve", id, approvedBy, name?, priority?, conflictGroup? }
 *   { action: "reject",  id, reviewedBy, reviewNotes? }
 *   { action: "edit",    id, patch }   // edit the draft before approving
 *
 * Approval is the ONLY path from proposal to an active KnowledgePolicy and
 * always requires an approver — AI can never self-activate.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const proposal = await getProposal(body.id);
    if (!proposal) {
      return NextResponse.json({ error: "proposal not found" }, { status: 404 });
    }

    switch (body.action) {
      case "approve": {
        if (!body.approvedBy) {
          return NextResponse.json(
            { error: "approvedBy required for approval" },
            { status: 400 }
          );
        }
        const policy = await approveProposalToPolicy(
          proposal,
          body.approvedBy,
          {
            name: body.name,
            priority: body.priority,
            conflictGroup: body.conflictGroup,
          }
        );
        return NextResponse.json({ policy });
      }
      case "reject": {
        const updated = await rejectProposal(
          body.id,
          body.reviewedBy ?? "reviewer",
          body.reviewNotes
        );
        return NextResponse.json({ proposal: updated });
      }
      case "edit": {
        const updated = await updateProposal(body.id, body.patch ?? {});
        return NextResponse.json({ proposal: updated });
      }
      default:
        return NextResponse.json(
          { error: "action must be approve | reject | edit" },
          { status: 400 }
        );
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
