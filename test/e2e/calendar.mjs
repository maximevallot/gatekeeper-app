// npm run e2e:calendar — the calendar link (one-model plan, gap 8) in a throwaway headless Brave: a feed with
// an exam tomorrow is read, Today offers exam mode until then, and one click starts it, logged as from the
// calendar. The feed is served on this computer; the test copy holds its host permission, as the rules page asks.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-cal-"));
const kill = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail).slice(0, 300)}`); if (!ok) failures++; };
process.on("exit", () => { for (const k of kill) try { k(); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

try {
  const exam = new Date(Date.now() + 26 * 3600e3);
  exam.setUTCSeconds(0, 0);
  const z = (n) => String(n).padStart(2, "0");
  const dt = `${exam.getUTCFullYear()}${z(exam.getUTCMonth() + 1)}${z(exam.getUTCDate())}T${z(exam.getUTCHours())}${z(exam.getUTCMinutes())}00Z`;
  const feed = createServer((req, res) => {
    // A web page that isn't a feed, like a calendar's share page (Maxime's re-test).
    if (req.url.startsWith("/share")) { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><title>Sign in</title>Sign in to see this calendar</html>"); return; }
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:15.401 Midterm\r\nDTSTART:${dt}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Office hours\r\nDTSTART:${dt}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  });
  await new Promise((r) => feed.listen(0, "127.0.0.1", r));
  kill.push(() => feed.close());

  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  // No relay in this run: the relay address goes nowhere, as for an install that is offline (this is how the
  // fresh-install clock bug of 2026-10-18 shows).
  { const cfg = join(ext, "config.js"); writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/export const RELAY_URL = ".*";/, 'export const RELAY_URL = "http://127.0.0.1:9";')); }
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("http://127.0.0.1/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  kill.push(() => browser.kill());

  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(800);
  await p.evaluate(`document.getElementById('skip-watch').click(); document.querySelector('.kind[data-kind=video]').click(); document.getElementById('start').click();`);
  await sleep(1200);
  const sw = await connect((t) => t.type === "service_worker");
  const base = (await sw.evaluate(`chrome.runtime.getURL("")`)).replace(/\/$/, "");
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  // Maxime's re-test: Google Calendar's share link is refused at once, with Google's own steps.
  await p.evaluate(`document.getElementById('calendar-edit').click(); document.getElementById('calendar-url').value = 'https://calendar.google.com/calendar/u/0?cid=bWF4aW1lQGV4YW1wbGUuY29t'; document.getElementById('calendar-form').requestSubmit();`);
  await sleep(800);
  const hint = await p.evaluate(`document.getElementById('calendar-hint').textContent`);
  check("a Google share link is refused with Google's steps", /share link/.test(hint) && /Secret address in iCal format/.test(hint), hint);
  // A web page instead of a feed: read once, found not to be one, not kept, and said.
  const page = await p.evaluate(`new Promise(r => chrome.runtime.sendMessage({ type: 'setCalendar', url: 'http://127.0.0.1:${feed.address().port}/share' }, r))`);
  let st0 = await sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  check("a link that isn't a feed is refused and not kept", page && page.refused === "not_ical" && !st0.calendar, { page, calendar: st0.calendar });
  const r = await p.evaluate(`new Promise(r => chrome.runtime.sendMessage({ type: 'setCalendar', url: 'http://127.0.0.1:${feed.address().port}/cal.ics' }, r))`);
  check("a pasted calendar link is read on this computer", r && r.ok && r.events === 2, r);
  await p.send("Page.reload"); await sleep(1000);
  const sub = await p.evaluate(`document.getElementById('calendar-sub').textContent`);
  check("the rules page says it's connected, with its next deadline and when it was read", /^Connected: next, 15\.401 Midterm/.test(sub) && /Last read/.test(sub), sub);

  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(1000);
  const offer = await p.evaluate(`document.getElementById('offer').classList.contains('hidden') ? '' : document.getElementById('offer-text').textContent`);
  check("Today offers exam mode until the midterm, and only for the exam", /^15\.401 Midterm, .*Start exam mode until then\?$/.test(offer), offer);
  let s = await sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  check("it never starts by itself", !s.rules.exam);
  await p.evaluate(`document.getElementById('offer-start').click()`); await sleep(1500);
  s = await sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  check("one click starts it until the exam", s.rules.exam && s.rules.exam.until === exam.getTime() && s.rules.exam.goal === "15.401 Midterm", s.rules.exam);
  check("logged as started from the calendar", (s.log || []).some((e) => e.type === "exam.start" && e.source === "calendar"), s.log);
  check("the feed's link and events stayed on this computer", !JSON.stringify(s.log).includes("127.0.0.1"));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:calendar ok");
process.exit(failures ? 1 : 0);
