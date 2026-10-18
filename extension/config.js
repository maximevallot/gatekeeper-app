// Where the relay is: deployed on Cloudflare since 2026-10-16. For development, `npm run dev` in ~/gatekeeper-relay
// serves it at http://localhost:8787 (the e2e test points its copy there). After changing this, `node scripts/sync-manifest.mjs` updates the
// manifest's host permission to match.
// 0.3.0 (branch account) talks to the staging relay only; testers on 0.2.0 keep the live one.
export const RELAY_URL = "https://gatekeeper-relay-staging.mvallot22.workers.dev";
