import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Recall's realtime webhook spec requires a trailing `/` before query
  // params on the configured URL (otherwise their delivery layer 400s
  // and silently disables the endpoint after 60 retries). With
  // skipTrailingSlashRedirect, both `…/foo` and `…/foo/` hit the same
  // route handler without a 308, so we can configure the trailing-slash
  // form on Recall's side and still serve direct hits without slashes.
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      // Daybreak Phase 2: /m/{botId} is the canonical meeting permalink.
      // Old links (Slack messages, HubSpot notes) keep working forever.
      {
        source: "/board/meeting/:botId",
        destination: "/m/:botId",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
