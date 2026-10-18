// The interface says "AI help" and speaks as Gatekeeper; only "What's sent" and the privacy text name Anthropic's
// Claude, which must stay accurate (Maxime's tester run, 2026-10-18, #6).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../extension/pages/", import.meta.url);
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");

test("no page says \"Claude\" to the user", () => {
  for (const f of readdirSync(dir).filter((x) => /\.(html|js)$/.test(x))) {
    const hits = code(readFileSync(new URL(f, dir), "utf8")).split("\n").filter((l) => /Claude/.test(l));
    assert.deepEqual(hits, [], f);
  }
});

test("the engine's lines to the user say \"AI help\", and only What's sent names Anthropic's Claude", async () => {
  const src = code(readFileSync(new URL("../extension/engine/engine.js", import.meta.url), "utf8"));
  const lines = src.split("\n").filter((l) => /Claude/.test(l) && /["`]/.test(l));
  assert.ok(lines.every((l) => /Anthropic's Claude/.test(l)), lines.join("\n"));
  const { SENT_TO } = await import("../extension/engine/engine.js");
  assert.match(SENT_TO, /Anthropic's Claude/);
});

test("What's sent says the video judge gets what the exam is for, and AI help is asked again for it", async () => {
  const { WHATS_SENT, CONSENT } = await import("../extension/engine/engine.js");
  assert.match(WHATS_SENT.find((w) => w.what === "Video rules").sent, /in exam mode what your exam is for/);
  assert.equal(CONSENT.help, 5);
});
