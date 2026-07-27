import { NextRequest, NextResponse } from "next/server";
import { listVersionGroups, linkVersions } from "@/lib/versioning";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const groups = await listVersionGroups();
    return NextResponse.json({ groups });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, groups: [] },
      { status: 500 }
    );
  }
}

/** Link documents into a version group. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.versionGroupId || !Array.isArray(body.members)) {
      return NextResponse.json(
        { error: "versionGroupId and members[] required" },
        { status: 400 }
      );
    }
    const group = await linkVersions(
      body.versionGroupId,
      body.title ?? body.versionGroupId,
      body.members,
      body.propertyName
    );
    return NextResponse.json({ group });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
