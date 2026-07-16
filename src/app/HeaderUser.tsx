"use client";

import { UserButton } from "@clerk/nextjs";

// Clerk-mode identity control in the app header. Sign-out ends the Clerk
// session, then ClerkProvider's afterSignOutUrl (/api/auth/logout) clears our
// signed viewer cookie and lands on home (protected → back to the Clerk
// sign-in). Only rendered when enforced auth is on, so <ClerkProvider> is
// guaranteed present in the tree.
export default function HeaderUser() {
  return <UserButton />;
}
