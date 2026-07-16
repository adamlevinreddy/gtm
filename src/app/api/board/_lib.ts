import { NextResponse } from "next/server";
import type { UpdateResult } from "@/lib/work-items";

/**
 * Translate a spine UpdateResult into the canonical board HTTP response:
 *  - ok            → 200 { ok:true, item } (item carries its new `version`)
 *  - conflict      → 409 { ok:false, reason:'conflict', current }
 *  - not_found     → 404 { ok:false, reason:'not_found', current:null }
 */
export function resultResponse(res: UpdateResult): NextResponse {
  if (res.ok) return NextResponse.json({ ok: true, item: res.item });
  const status = res.reason === "not_found" ? 404 : 409;
  return NextResponse.json(
    { ok: false, reason: res.reason, current: res.current },
    { status }
  );
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
