// npm run e2e:watch — the watch-only first week in a throwaway headless Brave: start it from the welcome
// tab, browse a watched site (counted, not blocked), see it in Today, then skip to setting limits, after
// which the same site closes. No relay. The test copy treats the user as present (the idle state is the Mac's).
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-watch-"));
let browser, failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
process.on("exit", () => { try { browser.kill(); } catch {} try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

try {
  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  // 0.3.0: no relay in this run, and never the live one's account endpoints: the relay address goes nowhere.
  { const cfg = join(ext, "config.js"); writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/export const RELAY_URL = ".*";/, 'export const RELAY_URL = "http://127.0.0.1:9";')); }
  const bg = join(ext, "hands", "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8").replace('(await chrome.idle.queryState(IDLE_SECONDS)) === "active"', "true"));
  browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(800);
  check("the welcome tab starts with the watch week", /just watching/.test(await p.evaluate(`document.querySelector('#watch h1').textContent`)));
  await p.evaluate(`document.getElementById('watch-goal').value = 'Finish problem set 4'; document.getElementById('start-watch').click()`);
  await sleep(800);
  const sw = await connect((t) => t.type === "service_worker");
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  let s = await st();
  check("the watch week runs seven days", s.watch && Math.round((s.watch.until - s.watch.from) / 86400e3) >= 6 && s.setupDone, s.watch);
  const base = (await sw.evaluate(`chrome.runtime.getURL("")`)).replace(/\/$/, "");

  await p.send("Page.enable");
  await p.send("Page.navigate", { url: "https://vimeo.com/" }); await sleep(7000);
  s = await st();
  check("a watched site opens and is counted", (await p.evaluate("location.href")).startsWith("https://vimeo.com") && (s.usage.seconds.video || 0) >= 4, s.usage.seconds);

  await p.send("Page.navigate", { url: base + "/pages/popup.html" }); await sleep(900);
  check("Today shows the watch week", /Watch week · day 1 of 7/.test(await p.evaluate(`document.getElementById('mode').textContent`)));
  check("Today offers to set limits now", /Set limits now/.test(await p.evaluate(`document.getElementById('change').textContent`)));

  await p.send("Page.navigate", { url: base + "/pages/welcome.html?after=watch" }); await sleep(1000);
  check("setting limits starts from the week", /Set limits from your week/.test(await p.evaluate(`document.getElementById('ask-title').textContent`)));
  await p.evaluate(`document.querySelector('.kind[data-kind=video]').click();
    for (let i = 0; i < 3; i++) document.querySelector('#minutes [data-step="-1"]').click();
    document.getElementById('start').click();`);
  await sleep(1500);
  s = await st();
  check("setting limits ends the watch week", s.watch.ended === true && s.rules.kinds.video && s.rules.kinds.video.minutes === 0, { watch: s.watch, kinds: s.rules.kinds });
  await p.send("Page.navigate", { url: "https://vimeo.com/" }); await sleep(2500);
  check("and the site closes", (await p.evaluate("location.href")).includes("/pages/gate.html"), await p.evaluate("location.href"));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:watch ok");
process.exit(failures ? 1 : 0);
