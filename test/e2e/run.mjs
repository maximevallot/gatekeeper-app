// npm run e2e — the extension against the real relay Worker under `wrangler dev`, with a fake Anthropic API,
// in a throwaway headless Brave profile. Checks the two milestone-2 paths:
//   1. a message at the gate gets a pass, and the closed site reopens for those minutes;
//   2. a site not in the catalog is sorted after a minute in front, and then counts against its kind.
// Needs ~/gatekeeper-relay with `npm install` done (or GATEKEEPER_RELAY_DIR), Brave (or BROWSER), and port
// 8787 free (or another port in RELAY_PORT). The browser's permission prompt cannot be answered headless, so the test copy of the extension
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
const RELAY_PORT = process.env.RELAY_PORT || "8787";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-e2e-"));
const children = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
const short = (u) => String(u).replace(/^chrome-extension:\/\/[a-z]+/, "ext:");

function cleanup() {
  for (const c of children) try { c.kill(); } catch {}
  (() => { try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} })();
}
process.on("exit", cleanup);

try {
  // The relay, as in its own smoke test.
  const mock = await startMock(KEY);
  const relay = spawn("npx", ["wrangler", "dev", "--port", RELAY_PORT, "--ip", "127.0.0.1", "--persist-to", join(work, "relay"),
    "--show-interactive-dev-session=false", "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`,
    "--var", "MAX_CALLS_PER_INSTALL:2"], // one gate message and one sort; the third call meets the daily limit
    { cwd: RELAY_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(relay);
  let relayLog = ""; relay.stdout.on("data", (d) => (relayLog += d)); relay.stderr.on("data", (d) => (relayLog += d));
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${RELAY_PORT}/`); break; } catch { if (i > 200) throw new Error("relay did not start\n" + relayLog); await sleep(300); }
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
  writeFileSync(config, readFileSync(config, "utf8").replace(/export const RELAY_URL = ".*";/, `export const RELAY_URL = "http://localhost:${RELAY_PORT}";`));
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("*://*/*", "http://localhost/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  // The browser's idle state is the whole Mac's: with nobody at the keyboard for a minute, nothing is
  // counted and the game is never sorted. The test copy treats the user as present.
  const bg = join(ext, "hands", "background.js");
  const code = readFileSync(bg, "utf8");
  const present = code.replace('(await chrome.idle.queryState(IDLE_SECONDS)) === "active"', "true");
  if (present === code) throw new Error("the idle check in hands/background.js moved; update the e2e harness");
  writeFileSync(bg, present);

  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  children.push(browser);

  // The welcome tab: video, games and news at 15 minutes, Claude help off; then video and news closed all day
  // with the rules page's steppers (closing applies at once).
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(600);
  await p.evaluate(`document.querySelector('.kind[data-kind=video]').click(); document.querySelector('.kind[data-kind=games]').click(); document.querySelector('.kind[data-kind=news]').click();`);
  await p.evaluate(`document.getElementById('goal').value = 'Finish problem set 4 by Thursday';`);
  await sleep(300);
  await p.evaluate(`document.getElementById('start').click()`);
  await sleep(800);
  const done = await p.evaluate(`document.getElementById('done-privacy').textContent`);
  check("M3: with Claude help off, the done panel says nothing leaves the browser", /Nothing leaves this browser/.test(done), done);
  const sw = await connect((t) => t.type === "service_worker");
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  const rulesUrl = (await sw.evaluate(`chrome.runtime.getURL("pages/rules.html")`));
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(1200);
  for (const k of ["video", "news"]) {
    for (let i = 0; i < 3; i++) { await p.evaluate(`document.querySelector('[data-kind=${k}] [data-step="-1"]').click()`); await sleep(120); }
    await sleep(1200);
  }
  let s = await st();
  check("the steppers closed video and news at once", s.rules.kinds.video.minutes === 0 && s.rules.kinds.news.minutes === 0 && !s.pending, s.rules.kinds);
  check("first run made an installId", /^[0-9a-f-]{36}$/.test(s.installId), s.installId);
  check("nothing is switched on before a yes", !s.talk && !s.sorting && !(s.consent || {}).help, { talk: s.talk, sorting: s.sorting, consent: s.consent });

  // 1. The gate: vimeo is closed; ask for the lecture.
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
  const log = await p.evaluate(`[...document.querySelectorAll('#log .bubble')].map(m => m.textContent)`);
  check("the reply and the pass show at the gate", log.some((t) => /^Pass: 10 minutes/.test(t)), log);
  await sleep(2500);
  check("the page reopens", (await p.evaluate("location.href")).startsWith("https://vimeo.com/"), await p.evaluate("location.href"));
  s = await st();
  const left = s.passes["vimeo.com"] && s.passes["vimeo.com"].secondsLeft;
  check("a 10-minute pass for vimeo.com only (the relay clamps 30 to 10)", left > 540 && left <= 600 && Object.keys(s.passes).length === 1, s.passes);
  await p.send("Page.navigate", { url: "https://vimeo.com/channels" });
  await sleep(2500);
  check("during the pass, vimeo stays open", (await p.evaluate("location.href")).startsWith("https://vimeo.com/"), await p.evaluate("location.href"));
  const sent = mock.requests.filter((r) => !r.body.system?.includes("You sort websites")).at(-1);
  check("Claude saw the site and the message, not the page's address", /vimeo\.com/.test(sent.body.messages[0].content) && !/channels/.test(sent.body.messages[0].content), sent.body.messages[0].content.slice(0, 300));

  // The switches show what is saved, and survive a reload (the bug of 2026-10-16 was a page that looked
  // ticked while nothing was saved).
  const switches = () => p.evaluate(`[document.getElementById('help').checked, !!document.getElementById('stale')]`);
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(1000);
  s = await st();
  check("the yes at the gate turned Claude help on, sorting included", JSON.stringify(await switches()) === "[true,false]" && s.sorting === true, { switches: await switches(), sorting: s.sorting });
  await p.evaluate(`document.getElementById('help').click()`); await sleep(800);
  await p.send("Page.reload"); await sleep(1000);
  s = await st();
  check("turning Claude help off survives a reload, and withdraws every yes", JSON.stringify(await switches()) === "[false,false]" && !s.talk && !s.sorting, { switches: await switches(), consent: s.consent });
  await p.evaluate(`document.getElementById('help').click()`); await sleep(800);
  await p.send("Page.reload"); await sleep(1000);
  s = await st();
  check("and turning it back on does too", JSON.stringify(await switches()) === "[true,false]" && s.talk === true && s.sorting === true, await switches());
  // New distracting sites: its own switch, on with AI help and access to every site, and it survives a reload.
  const newSites = () => p.evaluate(`[document.getElementById('new-sites').checked, document.getElementById('new-sites').disabled, document.getElementById('new-sites-sub').textContent]`);
  check("New distracting sites shows on", (await newSites())[0] === true && /^On: /.test((await newSites())[2]), await newSites());
  await p.evaluate(`document.getElementById('new-sites').click()`); await sleep(800);
  await p.send("Page.reload"); await sleep(1000);
  s = await st();
  check("turning it off stops sorting and survives a reload, AI help stays on", (await newSites())[0] === false && s.sorting === false && s.talk === true && /knows \d+ distracting sites/.test((await newSites())[2]), { sw: await newSites(), sorting: s.sorting });
  await p.evaluate(`document.getElementById('new-sites').click()`); await sleep(800);
  await p.send("Page.reload"); await sleep(1000);
  s = await st();
  check("and back on", (await newSites())[0] === true && s.sorting === true, { sw: await newSites(), sorting: s.sorting });

  // 2. Sorting: a minute on the unknown game.
  await p.send("Page.navigate", { url: GAME });
  const t0 = Date.now();
  for (let i = 0; i < 45; i++) { await sleep(2000); s = await st(); if (s.sorted && s.sorted["mygame.localhost"]) break; }
  check(`the unknown game was sorted after about a minute (${Math.round((Date.now() - t0) / 1000)} s)`, s.sorted["mygame.localhost"] === "games", s.sorted);
  await sleep(6000);
  s = await st();
  check("and now counts against games", (s.usage.seconds.games || 0) >= 2, s.usage.seconds);
  check("the relay was asked to sort it once", mock.requests.filter((r) => r.body.system?.includes("You sort websites")).length === 1);

  // M2: the relay's daily limit shows as such, not as "can't reach".
  await p.send("Page.navigate", { url: "https://www.nytimes.com/" }); await sleep(2500);
  await p.evaluate(`document.getElementById('message').value = 'I need one article for class'; document.getElementById('form').requestSubmit();`);
  await sleep(2500);
  const limit = await p.evaluate(`[...document.querySelectorAll('#log .bubble')].map(m => m.textContent).join(' | ')`);
  check("M2: the daily limit says the gate has answered enough", /answered enough for today/.test(limit), limit);
} catch (e) {
  console.log("FAIL", e.message);
  failures++;
}
console.log(failures ? `${failures} failed` : "e2e ok");
process.exit(failures ? 1 : 0);
