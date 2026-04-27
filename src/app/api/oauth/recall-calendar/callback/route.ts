import { NextRequest, NextResponse } from "next/server";
import { RECALL_GOOGLE_OAUTH_CALLBACK } from "@/lib/recall-calendar";

// Google redirects here after the user consents. Per Recall's V1 docs we
// must NOT exchange the code ourselves — we forward all query params
// (including `code` and the `state` blob with the Recall JWT) via 302
// to Recall's google_oauth_callback. Recall does the token exchange,
// stores tokens against the calendar user, then redirects to the
// success_url that's embedded in `state`.
export async function GET(req: NextRequest) {
  const search = req.nextUrl.search; // includes leading "?"
  return NextResponse.redirect(`${RECALL_GOOGLE_OAUTH_CALLBACK}${search}`, 302);
}
