import { NextRequest, NextResponse } from "next/server";
import { getProposal, updateProposal } from "@/lib/policies";
import {
  simulateProposalImpact,
  listSimulations,
} from "@/lib/impact-simulation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const simulations = await listSimulations();
    return NextResponse.json({ simulations });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, simulations: [] },
      { status: 500 }
    );
  }
}

/**
 * Run an impact simulation for a proposal before approval:
 *   { proposalId, sampleQueries: string[], topN?, ctx? }
 * Retrieval is live (needs an Atlas connection). The simulation is persisted
 * and linked back to the proposal.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const proposal = await getProposal(body.proposalId);
    if (!proposal) {
      return NextResponse.json({ error: "proposal not found" }, { status: 404 });
    }
    const queries: string[] = body.sampleQueries ?? [proposal.suggestedPolicy.matchConditions.terms?.[0] ?? proposal.description];
    const sim = await simulateProposalImpact(proposal, queries, {
      topN: body.topN,
      ctx: body.ctx,
    });
    await updateProposal(proposal.id, { impactSimulationId: sim.id });
    return NextResponse.json({ simulation: sim });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
