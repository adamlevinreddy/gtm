import { NextResponse } from "next/server";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const base = process.env.PUBLIC_BASE_URL ?? "https://reddy-gtm.com";
  const res = NextResponse.redirect(`${base}/`);
  res.cookies.set(VIEWER_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
