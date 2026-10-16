import test from "node:test";
import assert from "node:assert/strict";
import { buildRules, domainRegex } from "../extension/hands/blocker.js";

const GATE = "chrome-extension://abc/pages/gate.html";

test("a closed domain is caught with its subdomains, and nothing else", () => {
  const re = new RegExp(domainRegex("agar.io"));
  for (const u of ["https://agar.io/", "http://www.agar.io/#party", "https://agar.io:443/x?y=1"]) assert.ok(re.test(u), u);
  for (const u of ["https://notagar.io/", "https://agar.io.evil.com/", "https://evil.com/?u=agar.io", "https://evil.com/agar.io"]) {
    assert.ok(!re.test(u), u);
  }
});

test("the gate receives the whole URL after the #", () => {
  const [rule] = buildRules(["youtube.com"], GATE);
  assert.equal(rule.action.redirect.regexSubstitution, GATE + "#\\0");
  const url = "https://www.youtube.com/watch?v=abc&t=3";
  assert.equal(url.replace(new RegExp(rule.condition.regexFilter), GATE + "#$&"), GATE + "#" + url);
  assert.deepEqual(buildRules([], GATE), []);
});
