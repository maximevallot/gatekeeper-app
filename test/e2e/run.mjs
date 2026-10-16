// npm run e2e — the extension against the real relay Worker under `wrangler dev`, with a fake Anthropic API,
// in a throwaway headless Brave profile. Checks the two milestone-2 paths:
//   1. a message at the gate gets a pass, and the closed site reopens for those minutes;
//   2. a site not in the catalog is sorted after a minute in front, and then counts against its kind.
// Needs ~/gatekeeper-relay with `npm install` done (or GATEKEEPER_RELAY_DIR), Brave (or BROWSER), and port
// 8787 free. The browser's permission prompt cannot be answered headless, so the test copy of the extension
// holds the all-sites permission from the start; everything else is the extension as it ships.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-anthropic.mjs";
import { connect, sleep } from "./cdp.mjs";

const RELAY_DIR = process.env.GATEKEEPER_RELAY_DIR || join(homedir(), "gatekeeper-relay");
const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const KEY = "sk-ant-e2e-not-a-real-key";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-e2e-"));
const children = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
const short = (u) => String(u).replace(/^chrome-extension:\/\/[a-z]+/, "ext:");

function cleanup() {
  for (const c of children) try { c.kill(); } catch {}
  rmSync(work, { recursive: true, force: true });
}
process.on("exit", cleanup);

try {
  // The relay, as in its own smoke test.
  const mock = await startMock(KEY);
  const relay = spawn("npx", ["wrangler", "dev", "--port", "8787", "--ip", "127.0.0.1", "--persist-to", join(work, "relay"),
    "--show-interactive-dev-session=false", "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`],
    { cwd: RELAY_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(relay);
  let relayLog = ""; relay.stdout.on("data", (d) => (relayLog += d)); relay.stderr.on("data", (d) => (relayLog += d));
  for (let i = 0; ; i++) {
    try { await fetch("http://127.0.0.1:8787/"); break; } catch { if (i > 200) throw new Error("relay did not start\n" + relayLog); await sleep(300); }
  }

  // A game the catalog does not know, served on this Mac.
  const game = createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Paper Game</title><h1>Paper Game</h1>"); });
  await new Promise((r) => game.listen(0, "127.0.0.1", r));
  children.push({ kill: () => game.close() });
  const GAME = `http://mygame.localhost:${game.address().port}/play`;

  // The extension as it ships, except that the all-sites permission is granted up front and it talks to the
  // local relay with the fake Anthropic API, never the deployed one.
  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  const config = join(ext, "config.js");
  writeFileSync(config, readFileSync(config, "utf8").replace(/export const RELAY_URL = ".*";/, 'export const RELAY_URL = "http://localhost:8787";'));
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("*://*/*", "http://localhost/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));

  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  children.push(browser);

  // The welcome tab: video closed all day (0 minutes), games 15 minutes, sorting on.
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(600);
  await p.evaluate(`document.querySelector('.kind[data-kind=video]').click(); document.querySelector('.kind[data-kind=games]').click();`);
  await p.evaluate(`(() => { const i = document.querySelector('#budgets input[data-kind=video]'); i.value = '0'; i.dispatchEvent(new Event('input'));
    document.getElementById('goal').value = 'Finish problem set 4 by Thursday'; document.getElementById('sorting').click(); })()`);
  await sleep(500);
  await p.evaluate(`document.getElementById('start').click()`);
  await sleep(800);
  const sw = await connect((t) => t.type === "service_worker");
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  let s = await st();
  check("first run made an installId", /^[0-9a-f-]{36}$/.test(s.installId), s.installId);
  check("sorting is on and the gate's talking is still off", s.sorting === true && s.talk === false, { sorting: s.sorting, talk: s.talk });

  // 1. The gate: vimeo is closed; ask for the lecture.
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: "https://vimeo.com/" });
  await sleep(2500);
  check("vimeo goes to the gate before it loads", short(await p.evaluate("location.href")).startsWith("ext:/pages/gate.html#https://vimeo.com/"), await p.evaluate("location.href"));
  const relayCallsBefore = mock.requests.length;
  await p.evaluate(`document.getElementById('message').value = 'I need the lecture 6 recording, it is only on Vimeo'; document.getElementById('form').requestSubmit();`);
  await sleep(500);
  check("before the yes, the consent text shows and nothing is sent",
    !(await p.evaluate(`document.getElementById('consent').classList.contains('hidden')`)) && mock.requests.length === relayCallsBefore);
  await p.evaluate(`document.getElementById('consent-yes').click()`);
  await sleep(1000);
  const log = await p.evaluate(`[...document.querySelectorAll('#log .msg')].map(m => m.textContent)`);
  check("the reply and the pass show at the gate", log.some((t) => /^Pass: 10 minutes/.test(t)), log);
  await sleep(2500);
  check("the page reopens", (await p.evaluate("location.href")).startsWith("https://vimeo.com/"), await p.evaluate("location.href"));
  s = await st();
  const left = Math.round((s.passes.video - Date.now()) / 60e3);
  check("a 10-minute pass for video (the relay clamps 30 to 10)", left >= 9 && left <= 10, s.passes);
  await p.send("Page.navigate", { url: "https://vimeo.com/channels" });
  await sleep(2500);
  check("during the pass, vimeo stays open", (await p.evaluate("location.href")).startsWith("https://vimeo.com/"), await p.evaluate("location.href"));
  const sent = mock.requests.filter((r) => !r.body.system?.includes("You sort websites")).at(-1);
  check("Claude saw the site and the message, not the page's address", /vimeo\.com/.test(sent.body.messages[0].content) && !/channels/.test(sent.body.messages[0].content), sent.body.messages[0].content.slice(0, 300));

  // 2. Sorting: a minute on the unknown game.
  await p.send("Page.navigate", { url: GAME });
  const t0 = Date.now();
  for (let i = 0; i < 45; i++) { await sleep(2000); s = await st(); if (s.sorted && s.sorted["mygame.localhost"]) break; }
  check(`the unknown game was sorted after about a minute (${Math.round((Date.now() - t0) / 1000)} s)`, s.sorted["mygame.localhost"] === "games", s.sorted);
  await sleep(6000);
  s = await st();
  check("and now counts against games", (s.usage.seconds.games || 0) >= 2, s.usage.seconds);
  check("the relay was asked to sort it once", mock.requests.filter((r) => r.body.system?.includes("You sort websites")).length === 1);
} catch (e) {
  console.log("FAIL", e.message);
  failures++;
}
console.log(failures ? `${failures} failed` : "e2e ok");
process.exit(failures ? 1 : 0);
