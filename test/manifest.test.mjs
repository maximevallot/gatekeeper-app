import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogPatterns, relayPattern } from "../scripts/sync-manifest.mjs";

const m = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("the extension may act only on the catalog's sites; anything else is asked for, one site at a time", () => {
  assert.deepEqual(m.host_permissions, [...catalogPatterns(), relayPattern()], "run node scripts/sync-manifest.mjs");
  assert.equal(relayPattern(), "https://gatekeeper-relay-staging.mvallot22.workers.dev/*", "0.3.0 talks to the staging relay only");
  assert.equal(m.version, "0.3.0");
  assert.equal(m.name, "Gatekeeper 0.3 (test)", "so it can't be taken for the testers' build");
  assert.deepEqual(m.optional_host_permissions, ["*://*/*"]);
  assert.ok(m.host_permissions.includes("*://*.agar.io/*"));
  assert.ok(m.host_permissions.includes("*://*.youtube-nocookie.com/*"), "QA round 2, H5: the privacy-mode YouTube player");
});

test("no permission beyond the four it needs, and nothing that reads pages; plain declarativeNetRequest, so a block holds where site access was withheld (C2)", () => {
  assert.deepEqual(m.permissions.sort(), ["alarms", "declarativeNetRequest", "idle", "storage"]);
  assert.equal(m.content_scripts, undefined);
  // The Mac app's link is optional, asked for by its switch on the rules page, so installing shows no new warning.
  assert.deepEqual(m.optional_permissions, ["nativeMessaging"]);
  // No "tabs" (Maxime, QA round 2 #3, "Make it visible"): withheld access is shown and logged, not prevented.
  assert.ok(!m.permissions.includes("tabs"));
  assert.ok(!m.permissions.includes("nativeMessaging"));
  // Only the gate is reachable from web pages, from any page a link to a closed site starts on (a narrower
  // list ends such a click on Chrome's error page), and under a per-session address pages cannot probe for.
  assert.deepEqual(m.web_accessible_resources, [{ resources: ["pages/gate.html"], matches: ["<all_urls>"], use_dynamic_url: true }]);
});

test("the 0.3 test build talks to the Mac's 0.3 test app, never 0.2's native host", () => {
  const bg = readFileSync(new URL("../extension/hands/background.js", import.meta.url), "utf8");
  assert.match(bg, /const MAC_HOST = "com\.gatekeeper\.helper\.test";/);
});
