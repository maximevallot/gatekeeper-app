// npm run e2e:access — QA round 2's findings that need a real browser, in a throwaway headless Brave:
//   #18 a youtube-nocookie.com player is blocked while Video is closed;
//   #3  site access withheld the way people do it (brave://extensions → Site access → On click): Maxime chose
//       "Make it visible", so Today says so with the step that restores it, and the week keeps the period;
//   #10 in exam mode, a site Gatekeeper doesn't know goes to the gate;
//   #2  the worker's clock moved three days ahead does not end exam mode: the relay's time (a local stand-in
//       here) says otherwise.
// The test copy holds every site up front, as a user who turned on Claude help would.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, targets, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const CDP_PORT = process.env.CDP_PORT || "9471";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-access-"));
const kill = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
process.on("exit", () => { for (const k of kill) try { k(); } catch {} (() => { try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} })(); });

try {
  // One local server: the relay's time (HEAD / with a real Date header), a course page with a nocookie player,
  // and a site Gatekeeper doesn't know.
  let timeAsked = 0, timeDown = false;
  const server = createServer((req, res) => {
    if (req.method === "HEAD") { timeAsked++; if (timeDown) { req.socket.destroy(); return; } res.writeHead(200, { date: new Date().toUTCString() }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url.startsWith("/course")
      ? '<title>Course page</title><iframe id="nc" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>'
      : "<title>Some notes</title><h1>notes</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  kill.push(() => server.close());
  const local = `http://127.0.0.1:${server.address().port}`;

  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  const config = join(ext, "config.js");
  writeFileSync(config, readFileSync(config, "utf8").replace(/export const RELAY_URL = ".*";/, `export const RELAY_URL = "${local}";`));
  const bg = join(ext, "hands", "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8").replace('(await chrome.idle.queryState(IDLE_SECONDS)) === "active"', "true"));
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("*://*/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${CDP_PORT}`, "about:blank"],
    { stdio: "ignore" });
  kill.push(() => browser.kill());

  // Welcome: Video at 15 minutes, Claude off; then Video closed on the rules page.
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"), CDP_PORT);
  await sleep(800);
  await p.evaluate(`document.querySelector('.kind[data-kind=video]').click()`); await sleep(300);
  await p.evaluate(`document.getElementById('start').click()`); await sleep(1000);
  const sw = await connect((t) => t.type === "service_worker", CDP_PORT);
  const id = await sw.evaluate("chrome.runtime.id");
  const base = `chrome-extension://${id}`;
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1200);
  for (let i = 0; i < 3; i++) { await p.evaluate(`document.querySelector('[data-kind=video] [data-step="-1"]').click()`); await sleep(150); }
  await sleep(1500);
  check("Video is closed", (await st()).rules.kinds.video.minutes === 0);
  check("#16: the rules page offers Undo for the tap", /Undo/.test(await p.evaluate(`document.getElementById('saved').textContent`)));

  // #18: the privacy-mode YouTube player on a course page.
  await p.send("Page.navigate", { url: local + "/course" }); await sleep(2500);
  const tree = (await p.send("Page.getFrameTree")).result.frameTree;
  const f = (tree.childFrames || [])[0];
  check("#18: the youtube-nocookie.com player is blocked", !!f && (f.frame.url.startsWith("chrome-error") || !!f.frame.unreachableUrl), f && f.frame);

  // #3: Site access "On click", set the way the extensions page sets it.
  const ex = await p.send("Target.createTarget", { url: "brave://extensions/?id=" + id });
  await sleep(1500);
  const xp = await connect((t) => t.id === ex.result.targetId, CDP_PORT);
  const set = await xp.evaluate(`new Promise(r => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "${id}", hostAccess: "ON_CLICK" }, () => r(chrome.runtime.lastError ? chrome.runtime.lastError.message : "ok")))`);
  check("site access set to On click", set === "ok", set);
  xp.close();
  await p.send("Target.closeTarget", { targetId: ex.result.targetId });
  await p.send("Target.activateTarget", { targetId: p.t.id });
  await sleep(2500);
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(1200);
  const today = await p.evaluate(`(document.getElementById('blind-today') || {}).textContent || ''`);
  check("#3: Today says plainly that Gatekeeper can't see youtube.com, with the step to fix it", /can't see/.test(today) && /youtube\.com/.test(today) && /Automatically allow access on the following sites/.test(today), today);
  check("QA round 3 #7: with Brave's own words, and a button that opens Gatekeeper's page", await p.evaluate(`!!document.querySelector('#blind-today #open-access')`));
  check("#3: the toolbar badge flags it", (await sw.evaluate(`chrome.action.getBadgeText({})`)) === "!");
  let href = "";
  const again = await connect((t) => t.type === "page" && t.url.startsWith("brave://extensions"), CDP_PORT).catch(() => null);
  if (again) again.close();
  const ex2 = await p.send("Target.createTarget", { url: "brave://extensions/?id=" + id }); await sleep(1500);
  const xp2 = await connect((t) => t.id === ex2.result.targetId, CDP_PORT);
  await xp2.evaluate(`new Promise(r => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "${id}", hostAccess: "ON_ALL_SITES" }, () => r("ok")))`);
  xp2.close();
  await p.send("Target.closeTarget", { targetId: ex2.result.targetId });
  await p.send("Target.activateTarget", { targetId: p.t.id });
  await sleep(3500);
  const log = (await st()).log.filter((e) => e.type === "access.withheld");
  check("#3: the period of withheld access is in the history", log.length === 1 && log[0].domains.includes("youtube.com"), log);
  await p.send("Page.navigate", { url: base + "/pages/week.html" }); await sleep(1200);
  check("#3: the week shows it", /Access withheld for .* on /.test(await p.evaluate(`(document.getElementById('withheld-week') || {}).textContent || ''`)));

  // #10: exam mode, then a site Gatekeeper doesn't know.
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  const until = Date.now() + 2 * 86400e3;
  const started = await p.evaluate(`chrome.runtime.sendMessage({ type: "startExam", until: ${until}, goal: "15.425 midterm", source: "rules" })`);
  check("exam mode starts", started && started.ok, started);
  await sleep(1500);
  await p.send("Page.navigate", { url: local + "/notes" });
  href = "";
  for (let i = 0; i < 10 && !href.includes("/pages/gate.html"); i++) { await sleep(500); href = await p.evaluate("location.href").catch(() => ""); }
  check("#10: in exam mode, a site Gatekeeper doesn't know goes to the gate", href.includes("/pages/gate.html#" + local + "/notes"), href);
  await sleep(800);
  check("#10: the gate says everything but study is closed", /Everything but study/.test(await p.evaluate(`document.getElementById('used').textContent`)));
  // Maxime's tester run, #1: in exam mode a search result page and a university's site load; the browser took every rule.
  const dyn = await sw.evaluate(`chrome.declarativeNetRequest.getDynamicRules().then((r) => r.map((x) => x.condition.urlFilter || "").filter(Boolean))`);
  check("tester #1: the search pages' allow rules are in the browser", dyn.includes("||google.*/search") && dyn.includes("||search.brave.com^"), dyn);
  for (const u of ["https://search.brave.com/search?q=mit+canvas", "https://web.mit.edu/"]) {
    await p.send("Page.navigate", { url: u }); await sleep(2500);
    const at = await p.evaluate("location.href").catch(() => "");
    check(`tester #1: in exam mode ${new URL(u).hostname} isn't sent to the gate`, !at.includes("/pages/gate.html"), at);
  }

  // #2: the worker's clock three days ahead, past the exam's end.
  await sw.evaluate(`(() => { self.__realNow = Date.now.bind(Date); Date.now = () => self.__realNow() + 3 * 86400e3; return 1; })()`);
  await sleep(5000);
  let s = await st();
  check("#2: exam mode is still on after the clock jumped three days", s.rules.exam && s.rules.exam.until === until && s.clock.floor < until, { exam: s.rules.exam, floor: s.clock.floor });
  check("#2: the relay's time was asked, and the clock is read with the difference", timeAsked >= 1 && s.clock.offset < -2.9 * 86400e3, { timeAsked, offset: s.clock.offset });
  check("#2: the day did not start over", s.usage.day === new Date(Date.now() - 4 * 3600e3).toLocaleDateString("en-CA"), s.usage.day);
  await p.send("Page.navigate", { url: "https://www.youtube.com/" });
  href = "";
  for (let i = 0; i < 10 && !href.includes("/pages/gate.html"); i++) { await sleep(500); href = await p.evaluate("location.href").catch(() => ""); }
  check("#2: YouTube is still closed", href.includes("/pages/gate.html"), href);

  // QA round 3 #6, offline: the clock walked forward 14 minutes at a time doesn't end exam mode or start tomorrow.
  timeDown = true;
  let st0 = await st();
  const day0 = st0.usage.day;
  await sw.evaluate(`(() => { self.__step = 0; Date.now = () => self.__realNow() + 3 * 86400e3 + self.__step * 14 * 60e3; return 1; })()`);
  for (let i = 1; i <= 8; i++) { await sw.evaluate(`self.__step = ${i}`); await sleep(2600); }
  s = await st();
  check("#6: 14-minute steps offline: exam mode still on, no new day, and the clock is held", s.rules.exam && s.rules.exam.until === until && s.usage.day === day0 && s.clock.held && s.clock.held.kind === "drift",
    { day: s.usage.day, day0, held: s.clock.held, exam: s.rules.exam && s.rules.exam.until });
  // QA round 3 #2, offline: then a night asleep, past 4:00. The day turns after 20 s without the relay; exam mode holds.
  const next4 = (() => { const d = new Date(); d.setHours(4, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); })();
  const sleepMs = next4 - Date.now() + 3600e3;
  await sw.evaluate(`(() => { const base = self.__realNow() + 3 * 86400e3 + 8 * 14 * 60e3 + ${sleepMs}; const t0 = self.__realNow(); Date.now = () => base + (self.__realNow() - t0); return 1; })()`);
  await sleep(26000);
  s = await st();
  check("#2: after a night asleep offline, the day turned over", s.usage.day !== day0, { day: s.usage.day, day0, held: s.clock.held });
  check("#2: exam mode still holds until the relay's time comes", !!(s.rules.exam && s.rules.exam.until === until), s.rules.exam);
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(1200);
  check("#2: Today says Gatekeeper is checking the time", /checking the time/.test(await p.evaluate(`(document.getElementById('clock-today') || {}).textContent || ''`)));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:access ok");
process.exit(failures ? 1 : 0);
