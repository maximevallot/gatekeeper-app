// npm run e2e:qa — browser checks for the QA findings of 2026-10-16 that need a real browser, in a
// throwaway headless Brave profile, with no relay:
//   C2  a watched site whose access is withheld is blocked, not opened, and the rules page says so;
//   H1  embedded players of a closed kind are blocked;
//   H3  when a kind closes, every open tab of it goes to the gate, not only the front one;
//   H5  the rules page warns that private windows are not covered;
//   M3  with Claude off, the welcome tab says nothing leaves the browser;
//   and the simplified design's Today, week and appearance.
// Withheld access is made by leaving youtube.com out of the test copy's host permissions, which is what
// site access "On click" or removing one site does to the extension's granted permissions.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, targets, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-qa-"));
const kill = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
process.on("exit", () => { for (const k of kill) try { k(); } catch {} (() => { try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} })(); });

try {
  const embeds = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<title>Course page</title><iframe id="yt" src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><iframe id="vm" src="https://player.vimeo.com/video/76979871"></iframe>');
  });
  await new Promise((r) => embeds.listen(0, "127.0.0.1", r));
  kill.push(() => embeds.close());

  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  // No relay in this run: the relay address goes nowhere, as for an install that is offline (this is how the
  // fresh-install clock bug of 2026-10-18 shows).
  { const cfg = join(ext, "config.js"); writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/export const RELAY_URL = ".*";/, 'export const RELAY_URL = "http://127.0.0.1:9";')); }
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions = m.host_permissions.filter((h) => h !== "*://*.youtube.com/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  kill.push(() => browser.kill());

  // Welcome: video 15 minutes, Claude off.
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(800);
  check("tester #2: the welcome starts with rules; watching first is the small second choice",
    !(await p.evaluate(`document.getElementById('ask').classList.contains('hidden')`)) && (await p.evaluate(`document.getElementById('watch').classList.contains('hidden')`)) && !!(await p.evaluate(`document.getElementById('watch-first')`)));
  await p.evaluate(`document.querySelector('.kind[data-kind=video]').click()`);
  await sleep(300);
  await p.evaluate(`document.getElementById('start').click()`);
  await sleep(1000);
  check("H5: after Start, the welcome tab has a private-windows step with the exact toggle", /Allow in Private/.test(await p.evaluate(`document.getElementById('private-text').textContent`)));
  check("M3: with Claude off, the done panel says nothing leaves the browser", /Nothing leaves this browser/.test(await p.evaluate(`document.getElementById('done-privacy').textContent`)));
  const sw = await connect((t) => t.type === "service_worker");
  const base = (await sw.evaluate(`chrome.runtime.getURL("")`)).replace(/\/$/, "");

  // C2: YouTube has minutes left, but Gatekeeper cannot see it, so it is blocked.
  await p.send("Page.enable");
  await sleep(2500); // a tick has run and written the rules
  const nav = await p.send("Page.navigate", { url: "https://www.youtube.com/" });
  await sleep(1500);
  check("C2: a watched site whose access is withheld is blocked", /BLOCKED_BY_CLIENT/.test(nav.result.errorText || "") || (await p.evaluate("location.href")).startsWith("chrome-error"), nav.result);
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1200);
  const blindText = await p.evaluate(`(document.getElementById('blind-warning') || {}).textContent || ''`);
  check("C2: the rules page says access to youtube.com was turned off", /youtube\.com/.test(blindText), blindText);
  check("tester #5: no Mac app has connected, so the rules page doesn't show its switch", await p.evaluate(`document.getElementById('mac-row').classList.contains('hidden')`));
  check("H5: the rules page's settings say private windows are not covered, with the toggle", /Not covered/.test(await p.evaluate(`document.getElementById('private-pill').textContent`)) && /Allow in Private/.test(await p.evaluate(`document.getElementById('private-sub').textContent`)));
  check("C2: the badge flags it", (await sw.evaluate(`chrome.action.getBadgeText({})`)) === "!");

  // H3: two Vimeo tabs open while video has time; then video closes, and both go to the gate.
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await p.send("Target.createTarget", { url: "https://vimeo.com/channels/staffpicks" })).result.targetId);
  await sleep(3000);
  for (let i = 0; i < 3; i++) { await p.evaluate(`document.querySelector('[data-kind=video] [data-step="-1"]').click()`); await sleep(120); }
  await sleep(4000);
  const after = (await targets()).filter((t) => ids.includes(t.id)).map((t) => t.url);
  check("H3: when video closes, every open Vimeo tab goes to the gate", after.length === 2 && after.every((u) => u.includes("/pages/gate.html#https://vimeo.com/")), after);

  // H1: a course page embedding YouTube and Vimeo players while video is closed.
  await p.send("Page.navigate", { url: `http://127.0.0.1:${embeds.address().port}/` }); await sleep(3000);
  const tree = (await p.send("Page.getFrameTree")).result.frameTree;
  const frames = (tree.childFrames || []).map((f) => ({ url: f.frame.url, unreachable: f.frame.unreachableUrl || "" }));
  const blocked = (f) => f.url.startsWith("chrome-error") || !!f.unreachable;
  check("H1: both embedded players are blocked", frames.length === 2 && frames.every(blocked), frames);

  // The simplified design: Today shows the closed kind locked, the week counts the gates shown, and the
  // appearance chosen on the rules page carries to every page.
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(1000);
  check("Today shows Video locked", (await p.evaluate(`!!document.querySelector('.ring[data-kind=video] .state.closed')`)) === true);
  check("Figtree loads from the extension's own fonts folder", await p.evaluate(`document.fonts.load('16px Figtree').then((f) => f.length > 0 && [...document.fonts].some((x) => /Figtree/.test(x.family) && x.status === "loaded"))`));
  await p.send("Page.navigate", { url: base + "/pages/week.html" }); await sleep(1000);
  const gatesShown = Number(await p.evaluate(`document.getElementById('gates').textContent`));
  check("the week counts the gates shown today", gatesShown >= 2, gatesShown);
  check("light is the default", (await p.evaluate(`document.documentElement.dataset.theme`)) === "light");
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  await p.evaluate(`document.querySelector('#appearance [data-choice=dark]').click()`);
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(800);
  check("Dark, once chosen, applies to the other pages", (await p.evaluate(`document.documentElement.dataset.theme`)) === "dark");

  // A catalog site with its own limit of 0 while its kind (News) is not watched: closed, with its own row.
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  await p.evaluate(`(() => { [...document.querySelectorAll('#kinds button.link')].find((b) => /Limit one site/.test(b.textContent)).click();
    document.getElementById('new-site').value = 'nytimes.com'; document.getElementById('new-kind').value = ''; document.getElementById('site-form').requestSubmit(); })()`);
  await sleep(1500);
  for (let i = 0; i < 3; i++) { await p.evaluate(`document.querySelector('[data-site-limit="nytimes.com"] [data-step="-1"]').click()`); await sleep(120); }
  await sleep(1500);
  const lim = await sw.evaluate(`chrome.storage.local.get('state').then(r => [r.state.rules.siteLimits, r.state.rules.kinds.news || null])`);
  check("a site's own limit: nytimes.com at 0 minutes, News still unwatched", lim[0]?.["nytimes.com"] === 0 && lim[1] === null, lim);
  await sleep(1500);
  await p.send("Page.navigate", { url: "https://www.nytimes.com/" }); await sleep(1500);
  check("nytimes.com goes to its own gate", (await p.evaluate("location.href")).includes("/pages/gate.html#https://www.nytimes.com/"), await p.evaluate("location.href"));
  check("the gate says its own limit closes it", /its own limit/.test(await p.evaluate(`document.getElementById('site').textContent`)) && /Closed all day/.test(await p.evaluate(`document.getElementById('headline').textContent`)));

  // Tester run: with AI help off, the chat asks first and, on "Not now", says plainly it needs AI help; nothing is sent.
  await p.send("Page.navigate", { url: base + "/pages/talk.html" }); await sleep(1000);
  await p.evaluate(`document.getElementById('chat-message').value = 'less social media'; document.getElementById('chat-form').requestSubmit();`); await sleep(600);
  const asked = !(await p.evaluate(`document.getElementById('chat-consent').classList.contains('hidden')`));
  await p.evaluate(`document.getElementById('chat-no').click()`); await sleep(500);
  const turns = await sw.evaluate(`chrome.storage.local.get('state').then(r => (r.state.thread.turns || []).length)`);
  check("tester: with AI help off the chat asks, then says plainly it needs AI help, and nothing is sent",
    asked && /needs AI help/.test(await p.evaluate(`(document.getElementById('chat-needs-help') || {}).textContent || ''`)) && turns === 0, { asked, turns });
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  check("tester #8: the calendar field says which link stays up to date", /Calendar Feed/.test(await p.evaluate(`document.getElementById('calendar-hint').textContent`)));

  // Start exam mode from Today (one-model plan, gap 2): it applies at once, and the rules page shows it.
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(800);
  await p.evaluate(`document.getElementById('exam-start').click()`); await sleep(300);
  check("tester #4: before the browser's all-sites prompt, one plain line says why, and that only site names are read",
    /only site names, never page content/.test(await p.evaluate(`(document.getElementById('exam-access-line') || {}).textContent || ''`)));
  const until = Date.now() + 2 * 86400e3;
  await p.evaluate(`(() => { const d = new Date(${until}), z = (n) => String(n).padStart(2, '0');
    document.getElementById('exam-until').value = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes());
    document.getElementById('exam-for').value = '15.425 midterm'; document.getElementById('exam-start-form').requestSubmit(); })()`);
  await sleep(1500);
  const st = await sw.evaluate(`chrome.storage.local.get('state').then(r => r.state.rules.exam)`);
  check("Start exam mode on Today turns it on at once", st && st.goal === "15.425 midterm" && Math.abs(st.until - until) < 120e3, st);
  check("Today shows it", /Exam mode until/.test(await p.evaluate(`document.getElementById('mode').textContent`)));
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  check("the rules page shows it, with End early", !(await p.evaluate(`document.getElementById('exam-row').classList.contains('hidden')`)) && (await p.evaluate(`document.getElementById('exam-start-row').classList.contains('hidden')`)));
  // QA round 3 #5: without access to every site (this build doesn't hold it), Today says sites it doesn't know stay open.
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(1000);
  check("QA round 3 #5: exam mode without every site says unknown sites stay open, with a way to close them", /stay open in this exam mode/.test(await p.evaluate(`(document.getElementById('exam-open-today') || {}).textContent || ''`)));

  // Tester run, #3: turning on private windows reloads the extension and closes the welcome tab; it comes back at the
  // done screen. Here the welcome is reopened at its done step, then the extension reloads as that switch makes it.
  await p.send("Page.navigate", { url: base + "/pages/welcome.html?step=done" }); await sleep(1500);
  // What that reload does, in steps: the welcome tab closes and the worker stops. (Headless Brave disables an extension
  // loaded from the command line when the real switch is flipped, so the switch itself can't be used here.)
  const welcomeTab = (await targets()).find((t) => t.type === "page" && t.url.includes("/pages/welcome.html?step=done"));
  await p.send("Target.closeTarget", { targetId: welcomeTab.id });
  await sleep(500);
  const swT = (await targets()).find((t) => t.type === "service_worker");
  const browserWs = (await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9334}/json/version`)).json()).webSocketDebuggerUrl;
  await new Promise((res) => { const ws = new WebSocket(browserWs); ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: "Target.closeTarget", params: { targetId: swT.id } })); setTimeout(() => { ws.close(); res(); }, 800); }; });
  // Chrome brings another tab to the front; that switch wakes Gatekeeper's worker.
  const blank = (await targets()).find((t) => t.type === "page" && t.url === "about:blank");
  const ctl = await connect((t) => t.id === blank.id);
  await ctl.send("Target.createTarget", { url: "about:blank" });
  await sleep(3000);
  const back = await connect((t) => t.type === "page" && t.url.includes("/pages/welcome.html?step=done"));
  await sleep(1200);
  check("tester #3: after the reload, the welcome comes back at the done screen", !(await back.evaluate(`document.getElementById('done').classList.contains('hidden')`)) && /You're set/.test(await back.evaluate(`document.getElementById('done-title').textContent`)));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:qa ok");
process.exit(failures ? 1 : 0);
