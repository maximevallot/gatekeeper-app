// npm run e2e:stale — the bug of 2026-10-16: Brave kept milestone 1's background worker running beside
// milestone 2's pages (the unpacked extension had not been reloaded), so the Claude switches looked ticked
// but nothing was saved. Builds that situation in a throwaway headless Brave: today's pages with the worker
// and engine from milestone 1 (commit 0304580). The pages must say Gatekeeper needs a reload, and a switch
// that was not saved must not stay ticked. No relay needed.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep } from "./cdp.mjs";

const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "gatekeeper-stale-"));
let browser, failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
process.on("exit", () => { try { browser.kill(); } catch {} rmSync(work, { recursive: true, force: true }); });

try {
  const ext = join(work, "extension");
  cpSync(join(repo, "extension"), ext, { recursive: true });
  for (const f of ["hands/background.js", "hands/blocker.js", "engine/engine.js", "engine/catalog.js"]) {
    writeFileSync(join(ext, f), execFileSync("git", ["show", `0304580:extension/${f}`], { cwd: repo }));
  }
  browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${process.env.CDP_PORT || 9334}`, "about:blank"],
    { stdio: "ignore" });
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"));
  await sleep(4000);
  check("the welcome tab says Gatekeeper needs a reload", /reload arrow on Gatekeeper/.test(await p.evaluate(`(document.getElementById('stale') || {}).textContent || ''`)));
  await p.evaluate(`document.querySelector('.kind[data-kind=games]').click(); document.getElementById('start').click()`);
  await sleep(800);
  const rules = (await p.evaluate("location.href")).replace("welcome.html", "rules.html");
  await p.send("Page.enable");
  await p.send("Page.navigate", { url: rules }); await sleep(4000);
  check("the rules page says so too", !!(await p.evaluate(`document.getElementById('stale')`)));
  await p.evaluate(`document.getElementById('talk').click()`); await sleep(1500);
  check("a switch the old worker did not save goes back to unticked", (await p.evaluate(`document.getElementById('talk').checked`)) === false);
  check("and the page says it was not saved", /not saved/.test(await p.evaluate(`document.getElementById('result').textContent`)));
} catch (e) {
  console.log("FAIL", e.message); failures++;
}
console.log(failures ? `${failures} failed` : "e2e:stale ok");
process.exit(failures ? 1 : 0);
