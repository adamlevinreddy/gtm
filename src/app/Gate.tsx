import WelcomeGate from "./WelcomeGate";
import { ssoEnabled } from "@/lib/auth";

// Server wrapper for the anonymous case. Only reached in PICKER mode — under
// enforced auth (Clerk) pages redirect to sign-in / /auth/sync instead, so
// this renders the picker. Every page renders <Gate /> for the anonymous
// case — never <WelcomeGate /> directly.
export default function Gate() {
  return <WelcomeGate sso={ssoEnabled()} />;
}
