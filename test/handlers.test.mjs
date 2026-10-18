// Every message a page sends has a handler in the background worker (a dropped handler showed up only as
// "the background didn't answer" in the browser; this catches it first).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../extension/", import.meta.url);
const bg = readFileSync(new URL("hands/background.js", dir), "utf8");
const handlers = new Set([...bg.slice(bg.indexOf("const handlers = {")).matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]));

test("every ask() from a page reaches a handler", () => {
  const asked = new Map();
  for (const f of readdirSync(new URL("pages/", dir)).filter((f) => f.endsWith(".js"))) {
    for (const m of readFileSync(new URL("pages/" + f, dir), "utf8").matchAll(/ask\("(\w+)"/g)) asked.set(m[1], f);
  }
  assert.ok(asked.size > 10);
  for (const [name, file] of asked) assert.ok(handlers.has(name), `${file} sends "${name}", which has no handler`);
});
