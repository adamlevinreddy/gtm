// ============================================================================
// HUBSPOT WRITE GUARD — hard, server-side, fail-safe.
//
// HubSpot is the system of record; an errant write is hard to reverse. During
// rollout we permit ACTUAL CHANGES to a tiny allowlist of companies (currently
// just Luminare Health). Every gated write helper calls assertWritableCompany()
// with the company the mutation belongs to; anything off the allowlist throws
// BEFORE the API call. Fail-safe by construction:
//   - HUBSPOT_WRITES_ENABLED must be exactly "true", else ALL writes throw.
//   - HUBSPOT_WRITE_ALLOWLIST must be a non-empty CSV of company ids, else throw.
// So a missing/blank config blocks writes rather than allowing them.
//
// NOTE: this guards writes that flow through our server helpers (hubspot.ts).
// The sandbox agent can technically curl HubSpot with the global key — it is NOT
// instructed to make HubSpot writes this phase, and the sync path is the only
// thing granted write helpers. See agent system prompt.
// ============================================================================

export function hubspotWritesEnabled(): boolean {
  return process.env.HUBSPOT_WRITES_ENABLED === "true";
}

export function hubspotWriteAllowlist(): Set<string> {
  return new Set(
    (process.env.HUBSPOT_WRITE_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function isCompanyWritable(companyId: string | null | undefined): boolean {
  if (!hubspotWritesEnabled() || !companyId) return false;
  return hubspotWriteAllowlist().has(String(companyId));
}

/** Throws unless writes are enabled AND companyId is on the allowlist. */
export function assertWritableCompany(companyId: string | null | undefined): void {
  if (!hubspotWritesEnabled()) {
    throw new Error("HubSpot writes are disabled (set HUBSPOT_WRITES_ENABLED=true to enable).");
  }
  const allow = hubspotWriteAllowlist();
  if (allow.size === 0) {
    throw new Error("HubSpot write allowlist is empty — refusing all writes (set HUBSPOT_WRITE_ALLOWLIST).");
  }
  if (!companyId || !allow.has(String(companyId))) {
    throw new Error(
      `HubSpot write blocked: company ${companyId ?? "(none)"} is not on the write allowlist [${[...allow].join(", ")}].`
    );
  }
}
