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
  assert.ok(CONSENT.help >= 5); // 6 on 0.3.0: through your account
});

test("no shown text says watch, watched or watching: it reads as watching someone (Maxime, 2026-10-18)", async () => {
  const bad = /(^|[^.\w$-])watch(ed|ing)?\b/i; // a word, not a property (t.watch) or an id (watch-goal)
  for (const f of readdirSync(dir).filter((x) => /\.(html|js)$/.test(x))) {
    const src = code(readFileSync(new URL(f, dir), "utf8"));
    // HTML: the text between tags. JS: string literals with a space in them (sentences, not ids or keys).
    const texts = f.endsWith(".html")
      ? [...src.matchAll(/>([^<]+)</g)].map((m) => m[1])
      : src.split("\n").flatMap((line) => [...line.matchAll(/"([^"]*\s[^"]*)"|`([^`]*\s[^`]*)`|'([^']*\s[^']*)'/g)].map((m) => m[1] || m[2] || m[3]));
    const hits = texts.map((t) => t.replace(/\$\{[^}]*\}/g, "")).filter((t) => bad.test(t) && !/youtube\.com\/watch|\?v=/.test(t));
    assert.deepEqual(hits, [], f);
  }
  const { describeChanges } = await import("../extension/engine/engine.js");
  assert.deepEqual(describeChanges({ kinds: { social: { minutes: 20 } } }, { kinds: {} }).map((c) => c.text), ["Social media: limit removed"]);
});
