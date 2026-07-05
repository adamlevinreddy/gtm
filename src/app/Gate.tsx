import WelcomeGate from "./WelcomeGate";
import { ssoEnabled } from "@/lib/workos";

// Server wrapper: reads the WorkOS env (client components can't) and renders
// the gate in SSO mode when configured. Every page renders <Gate /> for the
// anonymous case — never <WelcomeGate /> directly.
export default function Gate() {
  return <WelcomeGate sso={ssoEnabled()} />;
}
