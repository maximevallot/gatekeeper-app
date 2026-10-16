// node scripts/sync-manifest.mjs — writes the catalog's domains into the manifest's host permissions, so
// the sites the extension may act on without asking are exactly the catalog. test/manifest.test.mjs fails
// if the two drift.
import { readFileSync, writeFileSync } from "node:fs";
import { KINDS, KIND_ORDER } from "../extension/engine/catalog.js";

export function catalogPatterns() {
  return KIND_ORDER.flatMap((k) => KINDS[k].domains).map((d) => `*://*.${d}/*`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = new URL("../extension/manifest.json", import.meta.url);
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.host_permissions = catalogPatterns();
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  console.log(`${m.host_permissions.length} sites written into the manifest`);
}
