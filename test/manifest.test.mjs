import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogPatterns, relayPattern } from "../scripts/sync-manifest.mjs";

const m = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("the extension may act only on the catalog's sites; anything else is asked for, one site at a time", () => {
  assert.deepEqual(m.host_permissions, [...catalogPatterns(), relayPattern()], "run node scripts/sync-manifest.mjs");
  assert.equal(relayPattern(), "https://gatekeeper-relay.mvallot22.workers.dev/*");
  assert.deepEqual(m.optional_host_permissions, ["*://*/*"]);
  assert.ok(m.host_permissions.includes("*://*.agar.io/*"));
});

test("no permission beyond the four it needs, and nothing that reads pages; plain declarativeNetRequest, so a block holds where site access was withheld (C2)", () => {
  assert.deepEqual(m.permissions.sort(), ["alarms", "declarativeNetRequest", "idle", "storage"]);
  assert.equal(m.content_scripts, undefined);
  // Only the gate is reachable from web pages, from any page a link to a closed site starts on (a narrower
  // list ends such a click on Chrome's error page), and under a per-session address pages cannot probe for.
  assert.deepEqual(m.web_accessible_resources, [{ resources: ["pages/gate.html"], matches: ["<all_urls>"], use_dynamic_url: true }]);
});
