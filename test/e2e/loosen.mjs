// npm run e2e:loosen — the agent's key to loosening, against the real relay Worker under `wrangler dev`
// with a fake Anthropic API, in a throwaway headless Brave: one question then a yes waits for the morning, a
// second request asks only about itself and its no keeps the first, a no locks loosening until tomorrow, and
// with the relay gone nothing loosens (QA round 2).
// Needs ~/gatekeeper-relay (with /loosen) and RELAY_PORT free (default 8798).
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-anthropic.mjs";
import { connect, sleep } from "./cdp.mjs";

const RELAY_DIR = process.env.GATEKEEPER_RELAY_DIR || join(homedir(), "gatekeeper-relay");
const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const KEY = "sk-ant-e2e-not-a-real-key";
const RELAY_PORT = process.env.RELAY_PORT || "8798";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-loosen-"));
const children = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail).slice(0, 400)}`); if (!ok) failures++; };
process.on("exit", () => { for (const c of children) try { c.kill(); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

try {
  const mock = await startMock(KEY);
  children.push({ kill: () => mock.close() });
  const relay = spawn("npx", ["wrangler", "dev", "--port", RELAY_PORT, "--ip", "127.0.0.1", "--persist-to", join(work, "relay"),
    "--show-interactive-dev-session=false", "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`],
    { cwd: RELAY_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true });
  const stopRelay = () => { try { process.kill(-relay.pid, "SIGTERM"); } catch {} };
  children.push({ kill: stopRelay });
  for (let i = 0; ; i++) { try { await fetch(`http://127.0.0.1:${RELAY_PORT}/`); break; } catch { if (i > 200) throw new Error("relay did not start"); await sleep(300); } }

  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("*://*/*", "http://localhost/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  const config = join(ext, "config.js");
  writeFileSync(config, readFileSync(config, "utf8").replace(/export const RELAY_URL = ".*";/, `export const RELAY_URL = "http://localhost:${RELAY_PORT}";`));
  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  children.push(browser);

  // Set up: skip the watch week, video at 15 minutes, Claude help on.
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(800);
  await p.evaluate(`document.getElementById('skip-watch').click(); document.querySelector('.kind[data-kind=video]').click();
    document.getElementById('goal').value = 'Finish the 15.390 slides'; document.getElementById('help').checked = true; document.getElementById('start').click();`);
  await sleep(1500);
  const sw = await connect((t) => t.type === "service_worker");
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  const rulesUrl = await sw.evaluate(`chrome.runtime.getURL("pages/rules.html")`);
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(1200);
  const plus = async (k, n) => { for (let i = 0; i < n; i++) { await p.evaluate(`document.querySelector('[data-kind=${k}] [data-step="1"]').click()`); await sleep(100); } await sleep(1500); };
  const card = () => p.evaluate(`!document.getElementById('loosen-card').classList.contains('hidden')`);
  const reason = async (text) => { await p.evaluate(`document.getElementById('loosen-message').value = ${JSON.stringify(text)}; document.getElementById('loosen-form').requestSubmit();`); await sleep(2500); };

  // 1. One question, then a yes: it waits for the morning.
  await plus("video", 2);
  let s = await st();
  check("a loosening with Claude help on asks for a reason", (await card()) && s.pending && s.pending.ok === false && s.rules.kinds.video.minutes === 15, s.pending);
  check("the card names the change", /Video: 15 min a day → 25 min a day/.test(await p.evaluate(`document.getElementById('loosen-changes').textContent`)));
  await reason("It's for school");
  check("a vague reason gets one question", /What changed for school/.test(await p.evaluate(`document.getElementById('loosen-log').textContent`)) && (await card()));
  await reason("Two lecture recordings a day for 15.390 now");
  s = await st();
  check("a real reason gets a yes that waits for the morning", s.pending && s.pending.ok === true && s.pending.from === s.usage.endsAt && s.rules.kinds.video.minutes === 15 && s.pending.rules.kinds.video.minutes === 25, s.pending);

  // 2. A second loosening asks only about itself (QA round 2, #12); its no keeps the approved one.
  await plus("video", 1);
  check("the second request names only what is new", /Video: 25 min a day → 30 min a day/.test(await p.evaluate(`document.getElementById('loosen-changes').textContent`)));
  await reason("I just want more");
  s = await st();
  check("a no keeps the approved change for the morning", s.pending && s.pending.ok === true && s.pending.rules.kinds.video.minutes === 25 && s.rules.kinds.video.minutes === 15
    && /ask again tomorrow/.test(await p.evaluate(`document.getElementById('saved').textContent`)), { pending: s.pending, saved: await p.evaluate(`document.getElementById('saved').textContent`) });
  // 3. After a no, no other loosening is asked until the morning (#11): not one more step either.
  await plus("video", 1);
  s = await st();
  check("after a no, one step more is refused until tomorrow", /said no to a loosening today/.test(await p.evaluate(`document.getElementById('saved').textContent`)) && !s.loosen && s.pending.rules.kinds.video.minutes === 25, { saved: await p.evaluate(`document.getElementById('saved').textContent`), pending: s.pending });

  // 4. With the relay gone, nothing loosens (#8): ending exam mode early keeps waiting, and exam mode stays on.
  const started = await p.evaluate(`chrome.runtime.sendMessage({ type: "startExam", until: Date.now() + 2 * 86400e3, goal: "midterm", source: "rules" })`);
  await p.evaluate(`chrome.runtime.sendMessage({ type: "endExam" })`);
  stopRelay();
  await sleep(1500);
  await p.send("Page.reload"); await sleep(1200);
  await reason("The exam was moved");
  s = await st();
  check("with the agent out of reach, exam mode stays on and the request keeps waiting", started.ok && s.rules.exam && s.rules.exam.until > Date.now() && s.loosen && s.loosen.kind === "exam"
    && /Nothing loosens yet/.test(await p.evaluate(`document.getElementById('saved').textContent`)), { exam: s.rules.exam, loosen: s.loosen });
  check("every request and answer is in the log", JSON.stringify(s.log.filter((e) => e.type === "loosen").map((e) => e.decision)) === JSON.stringify(["ask", "allow", "deny", "unavailable"]), s.log.filter((e) => e.type === "loosen"));
  check("the agent saw the change and the reason", mock.requests.some((r) => r.body.system?.includes("You hold the key") && /Video: 25 min a day → 30 min a day/.test(r.body.messages[0].content) && /I just want more/.test(r.body.messages[0].content)));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:loosen ok");
process.exit(failures ? 1 : 0);
