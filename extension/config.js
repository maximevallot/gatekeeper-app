// Where the relay is. Development: `npm run dev` in ~/gatekeeper-relay serves it here. Once the relay is
// deployed, its workers.dev address replaces this, and `node scripts/sync-manifest.mjs` updates the
// manifest's host permission to match.
export const RELAY_URL = "http://localhost:8787";
