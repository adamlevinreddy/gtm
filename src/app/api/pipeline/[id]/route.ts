import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv-client";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const results = await kv.get(`pipeline:${id}`);
  if (!results) {
    return NextResponse.json({ error: "Pipeline results not found" }, { status: 404 });
  }
  return NextResponse.json(results);
}
