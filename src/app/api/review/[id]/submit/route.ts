import { NextRequest, NextResponse } from "next/server";
import { submitDecisions, getReview } from "@/lib/kv";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const decisions: Record<string, "accept" | "reject"> = body.decisions;

  if (!decisions || typeof decisions !== "object") {
    return NextResponse.json({ error: "decisions is required" }, { status: 400 });
  }

  const review = await getReview(id);
  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "pending") {
    return NextResponse.json({ error: `Review already ${review.status}` }, { status: 409 });
  }

  await submitDecisions(id, decisions);
  return NextResponse.json({ ok: true, status: "submitted" });
}
