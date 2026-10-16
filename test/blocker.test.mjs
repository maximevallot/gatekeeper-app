import test from "node:test";
import assert from "node:assert/strict";
import { buildRules, domainRegex } from "../extension/hands/blocker.js";

const GATE = "chrome-extension://abc/pages/gate.html";

test("a closed domain is caught with its subdomains and a trailing dot, and nothing else", () => {
  const re = new RegExp(domainRegex("agar.io"));
  for (const u of ["https://agar.io/", "http://www.agar.io/#party", "https://agar.io:443/x?y=1", "https://www.agar.io./"]) assert.ok(re.test(u), u);
  for (const u of ["https://notagar.io/", "https://agar.io.evil.com/", "https://evil.com/?u=agar.io", "https://evil.com/agar.io"]) {
    assert.ok(!re.test(u), u);
  }
});

test("the gate receives the whole URL after the #", () => {
  const [rule] = buildRules({ redirect: ["youtube.com"] }, GATE);
  assert.equal(rule.action.redirect.regexSubstitution, GATE + "#\\0");
  const url = "https://www.youtube.com/watch?v=abc&t=3";
  assert.equal(url.replace(new RegExp(rule.condition.regexFilter), GATE + "#$&"), GATE + "#" + url);
  assert.deepEqual(buildRules({}, GATE), []);
});

test("H1 and C2: a block rule covers frames and pages, below the redirect, for closed and unseen sites", () => {
  const rules = buildRules({ redirect: ["youtube.com"], block: ["youtube.com", "instagram.com"] }, GATE);
  const redirect = rules.find((r) => r.action.type === "redirect");
  const block = rules.find((r) => r.action.type === "block");
  assert.ok(redirect.priority > block.priority, "where the redirect can fire, it wins");
  assert.deepEqual(block.condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.deepEqual(block.condition.requestDomains, ["youtube.com", "instagram.com"]);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
});
