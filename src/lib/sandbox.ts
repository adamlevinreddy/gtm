import { Sandbox } from "@vercel/sandbox";

/**
 * Get-or-create a named persistent sandbox, self-healing the stuck state where
 * a sandbox exists but `Sandbox.get({ resume: true })` can't revive it (expired
 * or bad snapshot) AND `Sandbox.create` then 400s with "already exists" — a
 * deadlock that otherwise 500s the agent. In that case we fetch the sandbox
 * without resuming, delete it, and recreate it fresh.
 *
 * `create` is a thunk so the caller owns the create params. Returns whether a
 * fresh sandbox was made, so the caller bootstraps packages only on first create.
 */
export async function getOrCreateSandbox(
  name: string,
  create: () => Promise<Sandbox>,
  log?: (msg: string) => void
): Promise<{ sandbox: Sandbox; created: boolean }> {
  try {
    return { sandbox: await Sandbox.get({ name, resume: true }), created: false };
  } catch (getErr) {
    log?.(`Sandbox.get miss for ${name} (${getErr instanceof Error ? getErr.message : String(getErr)}) — creating`);
  }
  try {
    return { sandbox: await create(), created: true };
  } catch (createErr) {
    const msg =
      (createErr as { json?: { error?: { message?: string } } })?.json?.error?.message ??
      (createErr instanceof Error ? createErr.message : String(createErr));
    if (!/already exists/i.test(msg)) throw createErr;
    // Stuck: the name is reserved but the snapshot couldn't be resumed.
    // Delete the dead sandbox and recreate it fresh.
    log?.(`Sandbox ${name} stuck (exists but unresumable) — deleting + recreating`);
    const stuck = await Sandbox.get({ name, resume: false }).catch(() => null);
    if (stuck) await stuck.delete().catch(() => {});
    return { sandbox: await create(), created: true };
  }
}
