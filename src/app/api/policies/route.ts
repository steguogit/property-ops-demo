import { NextRequest, NextResponse } from "next/server";
import {
  listPolicies,
  createPolicy,
  deactivatePolicy,
  reactivatePolicy,
} from "@/lib/policies";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get("status") as
      | import("@/lib/mongo").PolicyStatus
      | null;
    const policies = await listPolicies(undefined, status ?? undefined);
    return NextResponse.json({ policies });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, policies: [] },
      { status: 500 }
    );
  }
}

/** Manually create an active policy (admin). Prefer the proposal->approve flow. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.policyType || !body.approvedBy) {
      return NextResponse.json(
        { error: "policyType and approvedBy are required" },
        { status: 400 }
      );
    }
    const policy = await createPolicy({
      tenantId: body.tenantId,
      policyType: body.policyType,
      status: body.status ?? "active",
      name: body.name ?? `${body.policyType} policy`,
      description: body.description ?? "",
      scope: body.scope ?? {},
      matchConditions: body.matchConditions ?? {},
      actions: body.actions ?? {},
      priority: body.priority ?? 50,
      conflictGroup: body.conflictGroup ?? null,
      createdFromProposalId: body.createdFromProposalId ?? null,
      approvedBy: body.approvedBy,
    });
    return NextResponse.json({ policy });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Rollback / reactivate a policy (reversible governance):
 *   { action: "deactivate", id, deactivatedBy, reason? }
 *   { action: "reactivate", id }
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    if (body.action === "deactivate") {
      await deactivatePolicy(
        body.id,
        body.deactivatedBy ?? "reviewer",
        body.reason
      );
    } else if (body.action === "reactivate") {
      await reactivatePolicy(body.id);
    } else {
      return NextResponse.json(
        { error: "action must be deactivate | reactivate" },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
