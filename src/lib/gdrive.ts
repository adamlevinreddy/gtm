// Google Drive ↔ Library bridge (Daybreak Arc V). The whole team has access
// to the shared Reddy folder; we LIST it via Composio (executed as the
// service user's connected Drive) and link straight to Drive — no byte
// proxying needed. Cached in KV so the Library render stays fast.

import { composio } from "@/lib/composio";
import { kv } from "@/lib/kv-client";

export const DRIVE_FOLDER_ID = process.env.DRIVE_SHARED_FOLDER_ID || "1MCjCHCagypCHe5Z4ysSvVGfuQRX2pnI1";
const SERVICE_USER = process.env.DRIVE_SERVICE_USER || "adam@reddy.io";
const CACHE_KEY = `gdrive:list:v1:${DRIVE_FOLDER_ID}`;

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime: string | null;
  folder: boolean;
};

type RawFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  modifiedTime?: string;
};

function normalize(items: RawFile[]): DriveFile[] {
  return items
    .filter((f): f is RawFile & { id: string; name: string } => !!f?.id && !!f?.name)
    .map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType ?? "application/octet-stream",
      webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      modifiedTime: f.modifiedTime ?? null,
      folder: f.mimeType === "application/vnd.google-apps.folder",
    }))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
}

function extractFiles(res: unknown): RawFile[] {
  // Composio response shapes vary by action version — hunt for the array.
  const data = (res as { data?: unknown })?.data ?? res;
  const candidates = [
    (data as { files?: RawFile[] })?.files,
    (data as { items?: RawFile[] })?.items,
    (data as { response_data?: { files?: RawFile[] } })?.response_data?.files,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

/** Top level of the shared Reddy folder. 10-min KV cache; null = Drive not
 * reachable (service user hasn't connected googledrive, or action failed). */
export async function listSharedDrive(): Promise<DriveFile[] | null> {
  const cached = await kv.get<{ files: DriveFile[] | null }>(CACHE_KEY).catch(() => null);
  if (cached) return cached.files;
  if (!process.env.COMPOSIO_API_KEY) return null;

  let files: DriveFile[] | null = null;
  // Action slugs differ across Composio toolkit versions — try both.
  for (const action of ["GOOGLEDRIVE_LIST_FILES", "GOOGLEDRIVE_FIND_FILE"]) {
    try {
      const res = await composio().tools.execute(action, {
        userId: SERVICE_USER,
        arguments: {
          q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
          query: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
          page_size: 100,
          fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
        },
        dangerouslySkipVersionCheck: true,
      });
      const raw = extractFiles(res);
      if (raw.length > 0) {
        files = normalize(raw);
        break;
      }
      // An empty-but-successful call is a valid answer from the first action.
      if ((res as { successful?: boolean })?.successful) {
        files = [];
        break;
      }
    } catch {
      /* try the next slug */
    }
  }

  // A null (fetch failed / Drive not connected) caches only briefly so one
  // transient Composio hiccup doesn't blank the Library's Drive section for
  // the full 10-minute window.
  await kv.set(CACHE_KEY, { files }, { ex: files ? 600 : 60 }).catch(() => {});
  return files;
}
