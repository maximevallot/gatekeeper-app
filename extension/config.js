// Where the relay is: deployed on Cloudflare since 2026-10-16. For development, `npm run dev` in ~/gatekeeper-relay
// serves it at http://localhost:8787 (the e2e test points its copy there). After changing this, `node scripts/sync-manifest.mjs` updates the
// manifest's host permission to match.
export const RELAY_URL = "https://gatekeeper-relay.mvallot22.workers.dev";
