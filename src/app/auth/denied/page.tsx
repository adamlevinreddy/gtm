import { SignOutButton } from "@clerk/nextjs";
import { ALLOWED_DOMAIN } from "@/lib/auth";
import { PLUM } from "@/lib/tokens";

export const dynamic = "force-dynamic";

// Terminal page for a signed-in Clerk user whose email isn't on the allowed
// domain. PUBLIC in the middleware matcher so it never bounces back through
// /auth/sync (which would loop forever on a wrong-domain session). The only
// way forward is to sign out and come back with a @reddy.io account.
export default function AccessDenied() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md text-center">
        <span
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl text-xl font-bold text-white"
          style={{ background: PLUM }}
        >
          R
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Wrong account</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">
          Reddy GTM is limited to <b>@{ALLOWED_DOMAIN}</b> Google accounts. You&apos;re signed in
          with a different one.
        </p>
        <SignOutButton>
          <button
            type="button"
            className="mt-6 rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
            style={{ background: PLUM }}
          >
            Sign out &amp; try again
          </button>
        </SignOutButton>
      </div>
    </main>
  );
}
