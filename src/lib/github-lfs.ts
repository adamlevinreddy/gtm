import crypto from "node:crypto";

// Git LFS Batch protocol helpers — talk directly to GitHub's LFS server
// (NOT api.github.com) to upload large blobs and request fresh signed
// download URLs. Auth is HTTP Basic with the PAT as password; "x-access-token"
// is the conventional username for fine-grained tokens.
//
// Spec: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md

export type LfsObject = { oid: string; size: number };

type BatchAction = {
  href?: string;
  header?: Record<string, string>;
  expires_at?: string;
};
type BatchObjectResponse = LfsObject & {
  actions?: { upload?: BatchAction; download?: BatchAction; verify?: BatchAction };
  error?: { code: number; message: string };
};
type BatchResponse = { objects?: BatchObjectResponse[] };

function lfsBase(repo: { owner: string; name: string }) {
  return `https://github.com/${repo.owner}/${repo.name}.git/info/lfs`;
}

function authHeader(pat: string): string {
  // GitHub LFS expects HTTP Basic for fine-grained PATs. Username "x-access-token"
  // is the conventional placeholder used by GitHub's own clients.
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  return `Basic ${basic}`;
}

// SHA-256 of the bytes — that's the "OID" Git LFS uses to address blobs.
export function lfsOid(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// The text body of the LFS pointer file that lives in git in place of the
// real bytes. Exactly this format — single trailing newline.
export function lfsPointerText(oid: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

// Parse an LFS pointer file body back into {oid, size}. Returns null if the
// content isn't a pointer (so callers can detect "this file isn't LFS-tracked").
export function parseLfsPointer(text: string): LfsObject | null {
  const oidMatch = text.match(/^oid sha256:([0-9a-f]{64})$/m);
  const sizeMatch = text.match(/^size (\d+)$/m);
  if (!oidMatch || !sizeMatch) return null;
  return { oid: oidMatch[1], size: Number.parseInt(sizeMatch[1], 10) };
}

async function batch(
  pat: string,
  repo: { owner: string; name: string },
  operation: "upload" | "download",
  objects: LfsObject[],
): Promise<BatchResponse> {
  const res = await fetch(`${lfsBase(repo)}/objects/batch`, {
    method: "POST",
    headers: {
      Authorization: authHeader(pat),
      "Content-Type": "application/vnd.git-lfs+json",
      Accept: "application/vnd.git-lfs+json",
    },
    body: JSON.stringify({ operation, transfers: ["basic"], objects }),
  });
  if (!res.ok) {
    throw new Error(`LFS batch ${operation} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as BatchResponse;
}

// Upload a blob to GitHub LFS. Two phases:
//   1) Batch request gets a presigned PUT URL (S3-backed CDN).
//   2) Stream bytes to that URL.
//   3) Optional verify callback tells GitHub the upload completed.
// If the OID already exists on the server, the batch response simply omits
// the upload action — we treat that as success.
export async function uploadLfsBlob(
  pat: string,
  repo: { owner: string; name: string },
  bytes: Buffer,
): Promise<LfsObject> {
  const oid = lfsOid(bytes);
  const size = bytes.length;
  const res = await batch(pat, repo, "upload", [{ oid, size }]);
  const obj = res.objects?.[0];
  if (!obj) throw new Error("LFS batch returned no object");
  if (obj.error) throw new Error(`LFS object error ${obj.error.code}: ${obj.error.message}`);

  if (obj.actions?.upload?.href) {
    const headers: Record<string, string> = {
      "Content-Length": String(size),
      ...(obj.actions.upload.header ?? {}),
    };
    // TS BodyInit doesn't accept Buffer/Uint8Array directly. Copy the
    // underlying bytes into a fresh ArrayBuffer (avoids SharedArrayBuffer
    // typing issues) and wrap in a Blob for the request.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const putRes = await fetch(obj.actions.upload.href, {
      method: "PUT",
      headers,
      body: new Blob([ab]),
    });
    if (!putRes.ok) {
      throw new Error(`LFS PUT -> ${putRes.status} ${await putRes.text()}`);
    }
  }
  // If a verify action is offered, GitHub wants confirmation that the PUT landed.
  if (obj.actions?.verify?.href) {
    const verifyRes = await fetch(obj.actions.verify.href, {
      method: "POST",
      headers: {
        Authorization: authHeader(pat),
        "Content-Type": "application/vnd.git-lfs+json",
        Accept: "application/vnd.git-lfs+json",
        ...(obj.actions.verify.header ?? {}),
      },
      body: JSON.stringify({ oid, size }),
    });
    if (!verifyRes.ok) {
      throw new Error(`LFS verify -> ${verifyRes.status} ${await verifyRes.text()}`);
    }
  }
  return { oid, size };
}

// Get a fresh presigned download URL for an LFS object. URLs expire in
// roughly 5 minutes, so callers fetch this just-in-time before sharing
// or downloading. Returns null if the object doesn't exist.
export async function lfsDownloadUrl(
  pat: string,
  repo: { owner: string; name: string },
  obj: LfsObject,
): Promise<{ url: string; expiresAt: string | null } | null> {
  const res = await batch(pat, repo, "download", [obj]);
  const o = res.objects?.[0];
  if (!o) return null;
  if (o.error) return null;
  const href = o.actions?.download?.href;
  if (!href) return null;
  return { url: href, expiresAt: o.actions?.download?.expires_at ?? null };
}
