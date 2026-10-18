// npm run e2e:mac — the Mac app's contract (version 1, ~/gatekeeper-mac/docs/contract.md) from the
// extension's side, in a throwaway headless Brave. A stand-in native host in the throwaway profile plays the
// bridge: it records each snapshot and answers with the requests queued for it. The test copy holds
// nativeMessaging from the start (the browser's prompt cannot be answered headless), and its one
// sendNativeMessage call posts to that stand-in instead.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-mac-"));
let browser, failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail).slice(0, 400)}`); if (!ok) failures++; };
process.on("exit", () => { try { browser.kill(); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

// The stand-in bridge: a local server the test copy posts each snapshot to, in place of the one
// sendNativeMessage call. It records the snapshot and answers with the requests queued for it, as the
// bridge would. (Brave on macOS reads native-messaging hosts only from the real per-user folder, where
// Gatekeeper for Mac registers the real bridge; the test does not touch it.)
const seen = [], queue = [];
let mode = "normal"; // Gatekeeper for Mac 0.2.0's other answers: "other" (it follows Safari), "outdated" (it reads v2 only)
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const msg = JSON.parse(raw || "{}");
    seen.push(msg);
    const mac = { version: "0.2.0", reads: mode === "outdated" ? [2] : [1] };
    const out = mode === "other" ? { ok: false, error: "other_browser_linked", linked: "com.apple.Safari", linkedName: "Safari", mac }
      : msg.v === 1 ? { ok: true, v: 1, requests: queue.splice(0), mac } : { ok: false, error: "unknown_version", mac };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.on("exit", () => server.close());
const snapshots = () => seen;

try {
  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  // 0.3.0: no relay in this run, and never the live one's account endpoints: the relay address goes nowhere.
  { const cfg = join(ext, "config.js"); writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/export const RELAY_URL = ".*";/, 'export const RELAY_URL = "http://127.0.0.1:9";')); }
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.permissions.push("nativeMessaging");
  m.optional_permissions = [];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  m.host_permissions.push("http://127.0.0.1/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
  const bgPath = join(ext, "hands", "background.js");
  const bgCode = readFileSync(bgPath, "utf8");
  const call = "await chrome.runtime.sendNativeMessage(MAC_HOST, snap)";
  if (!bgCode.includes(call)) throw new Error("the sendNativeMessage call moved; update the e2e harness");
  writeFileSync(bgPath, bgCode.replace(call, `await (await fetch("http://127.0.0.1:${server.address().port}/native", { method: "POST", body: JSON.stringify(snap) })).json()`));
  const profile = join(work, "profile");
  browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  const id = p.t.url.match(/^chrome-extension:\/\/([a-z]+)/)[1];
  await sleep(800);
  await p.evaluate(`document.getElementById('skip-watch').click(); document.querySelector('.kind[data-kind=social]').click(); document.getElementById('goal').value = 'Finish problem set 4'; document.getElementById('start').click();`);
  await sleep(1000);
  const sw = await connect((t) => t.type === "service_worker");
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  const rulesUrl = await sw.evaluate(`chrome.runtime.getURL("pages/rules.html")`);
  const base = (await sw.evaluate(`chrome.runtime.getURL("")`)).replace(/\/$/, "");
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(2500);

  let snaps = snapshots();
  const first = snaps[snaps.length - 1] || {};
  check("a snapshot reached the bridge", snaps.length >= 1, snaps.length);
  check("it follows the contract", first.type === "snapshot" && first.v === 1 && first.extensionId === id && first.base === `chrome-extension://${id}/` && first.pages.talk === "pages/talk.html"
    && first.pages.exam === "pages/rules.html#exam" && first.goal === "Finish problem set 4" && first.reopensAt > Date.now() && first.exam === null && first.waiting === false, first);
  const k = (first.kinds || [])[0] || {};
  check("with each watched kind and what the engine decided", first.kinds.length === 1 && k.kind === "social" && k.short === "Social" && k.minutes === 15 && k.left === 15 && k.status === "open" && k.fraction > 0.99, first.kinds);
  check("the rules page says the Mac app is connected", /Connected/.test(await p.evaluate(`document.getElementById('mac-sub').textContent`)));

  // exam.start from the Mac: applied at once, every kind closed, and reported in the next snapshot.
  const until = Date.now() + 2 * 86400e3; // past the next morning, so ending early is a real request
  queue.push(...([{ id: "6F1C", type: "exam.start", until, goal: "15.425 midterm" }]));
  await p.send("Page.reload"); await sleep(3000);
  let s = await st();
  check("exam.start was applied", s.rules.exam && s.rules.exam.until === until && s.rules.exam.goal === "15.425 midterm", s.rules.exam);
  snaps = snapshots();
  check("and shows in the next snapshot", snaps.some((x) => x.exam && x.exam.until === until), snaps.map((x) => x.exam));
  await p.send("Page.navigate", { url: "https://www.youtube.com/" }); await sleep(2500);
  check("YouTube, not even watched, is closed for the exam", /Exam mode until/.test(await p.evaluate(`(document.getElementById('headline') || {}).textContent || ''`)));

  // The Mac only tightens: an exam.end from it is refused, even with the sentence.
  queue.push(...([{ id: "9A21", type: "exam.end", sentence: "I am choosing to stop preparing for my exam" }]));
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(3000);
  check("exam.end from the Mac is refused, even with the sentence", !!((await st()).rules.exam), (await st()).rules.exam);
  // "End exam mode early" on the Mac opens pages.exam: the rules page, with "End early" ready. Claude help is off
  // here, so exam mode runs to its end (decision 3), and the page says so.
  await p.send("Page.navigate", { url: base + "/" + first.pages.exam }); await sleep(1500);
  check("pages.exam opens the rules page at End early", (await p.evaluate(`document.activeElement && document.activeElement.id`)) === "exam-end-open");
  await p.evaluate(`document.getElementById('exam-end-open').click()`); await sleep(1500);
  check("with Claude help off, exam mode runs to its end, and the page says so",
    /runs to its end/.test(await p.evaluate(`document.getElementById('exam-note').textContent`)) && !!((await st()).rules.exam), await p.evaluate(`document.getElementById('exam-note').textContent`));
  check("and the snapshot still shows it", snapshots().slice(-1)[0].exam && snapshots().slice(-1)[0].exam.until === until);

  // Gatekeeper for Mac 0.2.0's replies: it follows another browser, or it can't read this version.
  mode = "other";
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(2000);
  check("a Mac app that follows Safari says so", /follows Safari/.test(await p.evaluate(`document.getElementById('mac-sub').textContent`)), await p.evaluate(`document.getElementById('mac-sub').textContent`));
  mode = "outdated";
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(2000);
  check("a Mac app that can't read v1 asks to be updated", /Update Gatekeeper for Mac/.test(await p.evaluate(`document.getElementById('mac-sub').textContent`)), await p.evaluate(`document.getElementById('mac-sub').textContent`));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:mac ok");
process.exit(failures ? 1 : 0);
