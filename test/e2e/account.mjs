// npm run e2e:account — one Gatekeeper per person (0.3.0), in two throwaway headless Brave profiles against the
// relay's account branch under `wrangler dev` (a copy of the branch, never the live relay), with the fake Anthropic
// API: profile A finishes the welcome and so makes the account; it shows a code; profile B joins with it; then
// rules, minutes, exam mode and the chat thread made on one show up on the other.
//
// RELAY_ACCOUNT_DIR: a checkout of the relay's account branch with node_modules (default: a copy made here from
// ~/gatekeeper-relay's `account` branch with `git archive`, using its node_modules).
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-anthropic.mjs";
import { connect, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const KEY = "sk-ant-e2e-not-a-real-key";
const RELAY_PORT = process.env.RELAY_PORT || "8796";
const PORT_A = process.env.CDP_PORT || "9501", PORT_B = String(Number(PORT_A) + 1);
const work = mkdtempSync(join(tmpdir(), "gatekeeper-account-"));
const children = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail).slice(0, 500)}`); if (!ok) failures++; };
process.on("exit", () => { for (const c of children) try { c.kill(); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

// A copy of the relay's account work (its worktree, uncommitted parts included), so wrangler writes nothing there.
function relayCopy() {
  const src = process.env.RELAY_ACCOUNT_DIR || join(homedir(), "gatekeeper-relay-0.3");
  const dir = join(work, "relay-src");
  mkdirSync(dir);
  execFileSync("rsync", ["-a", "--exclude", "node_modules", "--exclude", ".wrangler", "--exclude", ".git", src + "/", dir + "/"]);
  const mods = existsSync(join(src, "node_modules")) ? join(src, "node_modules") : join(homedir(), "gatekeeper-relay", "node_modules");
  symlinkSync(mods, join(dir, "node_modules"));
  return dir;
}

async function startBrowser(name, port, relay) {
  const ext = join(work, "ext-" + name);
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  const config = join(ext, "config.js");
  writeFileSync(config, readFileSync(config, "utf8").replace(/export const RELAY_URL = ".*";/, `export const RELAY_URL = "${relay}";`));
  const bg = join(ext, "hands", "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8").replace('(await chrome.idle.queryState(IDLE_SECONDS)) === "active"', "true"));
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("*://*/*", "http://localhost/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  const b = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile-" + name)}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
  children.push(b);
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"), port);
  await sleep(800);
  const sw = await connect((t) => t.type === "service_worker", port);
  const base = (await sw.evaluate(`chrome.runtime.getURL("")`)).replace(/\/$/, "");
  const msg = (type, body = {}) => p.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...body })})`);
  const st = () => sw.evaluate(`chrome.storage.local.get(['state', 'account', 'outbox']).then(r => r)`);
  await p.send("Page.enable");
  return { p, sw, base, msg, st };
}

try {
  const mock = await startMock(KEY);
  children.push({ kill: () => mock.close() });
  const dir = relayCopy();
  const relay = spawn("npx", ["wrangler", "dev", "--port", RELAY_PORT, "--ip", "127.0.0.1", "--persist-to", join(work, "relay-state"),
    "--show-interactive-dev-session=false", "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`],
    { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let relayLog = ""; relay.stdout.on("data", (d) => (relayLog += d)); relay.stderr.on("data", (d) => (relayLog += d));
  children.push({ kill: () => { try { process.kill(-relay.pid, "SIGTERM"); } catch {} } });
  for (let i = 0; ; i++) { try { await fetch(`http://127.0.0.1:${RELAY_PORT}/`); break; } catch { if (i > 200) throw new Error("relay did not start\n" + relayLog.slice(-2000)); await sleep(300); } }
  const RELAY = `http://localhost:${RELAY_PORT}`;

  // A site of the user's own in Games, served here: play.localhost resolves to this computer.
  const site = createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>A game</title><h1>game</h1>"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  children.push({ kill: () => site.close() });
  const GAME = `http://play.localhost:${site.address().port}/`;

  // A: finishing the welcome makes the account.
  const A = await startBrowser("a", PORT_A, RELAY);
  check("the welcome says plainly that finishing makes an account", /Finishing makes your Gatekeeper account/.test(await A.p.evaluate(`document.querySelector('.account-line').textContent`)));
  await A.msg("setup", { kinds: { games: 20, video: 30 }, goal: "Finish chapter 3" });
  await A.msg("consent", { help: true });
  let a = await A.st();
  check("A has an account after the welcome", !!(a.account && a.account.token && a.account.accountId), a.account);
  check("the state sent never holds the token", !JSON.stringify(a.state).includes(a.account.token));
  check("A's install number is the account's ID", a.state.installId === a.account.accountId, { installId: a.state.installId });
  await A.msg("propose", { rules: { ...a.state.rules, sites: { "play.localhost": "games" } } });

  // A shows a code on the rules page.
  await A.p.send("Page.navigate", { url: A.base + "/pages/rules.html" }); await sleep(1500);
  await A.p.evaluate(`document.getElementById('add-device').click()`); await sleep(1500);
  const code = (await A.p.evaluate(`document.getElementById('device-code').textContent`)).trim();
  check("Add a device shows a 6-digit code", /^\d{6}$/.test(code), code);

  // B: "Already use Gatekeeper?" on its welcome.
  const B = await startBrowser("b", PORT_B, RELAY);
  await B.p.evaluate(`document.getElementById('join-code').value = ${JSON.stringify(code)}; document.getElementById('join-form').requestSubmit();`);
  await sleep(3000);
  let b = await B.st();
  check("B joined the same account", b.account && b.account.accountId === a.account.accountId && !!b.account.token, b.account);
  check("B's welcome says it's in", /You're in your Gatekeeper/.test(await B.p.evaluate(`document.getElementById('done-title').textContent`)));
  check("B has A's rules", b.state.rules.kinds.games && b.state.rules.kinds.games.minutes === 20 && b.state.rules.sites["play.localhost"] === "games", b.state.rules);
  check("a used code doesn't work twice", (await (await fetch(`${RELAY}/account/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, code, device: { name: "x", kind: "extension" }, tz: "America/New_York", now: Date.now() }) })).json()).error === "bad_code");

  // Rules: a tightening on A reaches B.
  a = await A.st();
  await A.msg("propose", { rules: { ...a.state.rules, kinds: { ...a.state.rules.kinds, games: { minutes: 10 } } } });
  await sleep(1500);
  await B.msg("syncNow"); await sleep(1000);
  b = await B.st();
  check("rules: Games 20 → 10 on A reaches B", b.state.rules.kinds.games.minutes === 10, b.state.rules.kinds);

  // Minutes: time on the game in B counts in the account, and A sees it.
  await B.p.send("Page.navigate", { url: GAME });
  await sleep(12000);
  await B.msg("syncNow").catch(() => null); await sleep(1500);
  await A.msg("syncNow"); await sleep(1000);
  a = await A.st();
  check("minutes: time in B shows on A", (a.state.usage.seconds.games || 0) >= 6, a.state.usage.seconds);

  // Exam mode started on B reaches A.
  const until = Date.now() + 2 * 86400e3;
  await B.p.send("Page.navigate", { url: B.base + "/pages/rules.html" }); await sleep(1000);
  await B.msg("startExam", { until, goal: "15.425 midterm", source: "rules" });
  await sleep(1500);
  await A.msg("syncNow"); await sleep(1000);
  a = await A.st();
  check("exam mode: started on B, on in A", a.state.rules.exam && a.state.rules.exam.until === until, a.state.rules.exam);

  // The chat: a message on A, answered by the account (it asks Claude), shows in B's thread with its card.
  await A.p.send("Page.navigate", { url: A.base + "/pages/talk.html" }); await sleep(1000);
  const said = await A.msg("chat", { message: "i want to put a limit on the site lequipe" });
  check("the chat is answered through the account", said && (said.ok || said.refused === undefined), said);
  await sleep(1000);
  await B.msg("syncNow"); await sleep(1000);
  b = await B.st();
  const turns = (b.state.thread.turns || []).map((t) => t.text);
  check("the chat thread: A's message is in B's thread", turns.includes("i want to put a limit on the site lequipe"), turns);
  check("the card is there too", !!(b.state.thread.card && JSON.stringify(b.state.thread.card).includes("lequipe.fr")), b.state.thread.card);
  check("Claude was asked once, by the account", mock.requests.filter((r) => r.body.system?.includes("You change the rules")).length === 1);

  // The device list, and leaving loosens nothing.
  await A.p.send("Page.navigate", { url: A.base + "/pages/rules.html" }); await sleep(2000);
  check("A's rules page lists both browsers", (await A.p.evaluate(`document.querySelectorAll('#devices [data-device]').length`)) === 2);
  const left = await B.msg("leaveAccount");
  b = await B.st();
  check("B leaves and keeps its copy: exam mode still on, Games still 10", left.ok && b.state.rules.exam && b.state.rules.kinds.games.minutes === 10 && !b.account.token, { left, exam: b.state.rules.exam, acct: b.account });
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:account ok");
process.exit(failures ? 1 : 0);
