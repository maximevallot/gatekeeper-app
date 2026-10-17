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
  await p.send("Page.navigate", { url: base + "/pages/week.html" }); await sleep(1000);
  const gatesShown = Number(await p.evaluate(`document.getElementById('gates').textContent`));
  check("the week counts the gates shown today", gatesShown >= 2, gatesShown);
  check("light is the default", (await p.evaluate(`document.documentElement.dataset.theme`)) === "light");
  await p.send("Page.navigate", { url: base + "/pages/rules.html" }); await sleep(1000);
  await p.evaluate(`document.querySelector('#appearance [data-choice=dark]').click()`);
  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(800);
  check("Dark, once chosen, applies to the other pages", (await p.evaluate(`document.documentElement.dataset.theme`)) === "dark");
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:qa ok");
process.exit(failures ? 1 : 0);
