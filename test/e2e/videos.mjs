// npm run e2e:videos — milestone 3 in a throwaway headless Brave: the rules chat turns Maxime's sentence
// ("block YouTube videos about video games but keep educational ones") into a card, Apply makes two video
// rules, and YouTube videos are then judged one by one and closed or let through.
//
// YouTube is played by a small HTTPS server on this Mac: the browser resolves www.youtube.com to it
// (--host-resolver-rules) and accepts its self-made certificate, so no real YouTube page or title is used.
// The relay runs under `wrangler dev` with the fake Anthropic API, as in run.mjs. Needs openssl, Brave (or
// BROWSER), ~/gatekeeper-relay with `npm install` done, and port 8787 free (or RELAY_PORT).
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-anthropic.mjs";
import { connect, sleep } from "./cdp.mjs";

const RELAY_DIR = process.env.GATEKEEPER_RELAY_DIR || join(homedir(), "gatekeeper-relay");
const BROWSER = process.env.BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const KEY = "sk-ant-e2e-not-a-real-key";
const RELAY_PORT = process.env.RELAY_PORT || "8787";
const CDP_PORT = process.env.CDP_PORT || "9335";
const work = mkdtempSync(join(tmpdir(), "gatekeeper-e2e-videos-"));
const children = [];
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`); if (!ok) failures++; };
const short = (u) => String(u).replace(/^chrome-extension:\/\/[a-z]+/, "ext:");

function cleanup() {
  for (const c of children) try { c.kill(); } catch {}
  (() => { try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} })();
}
process.on("exit", cleanup);

const VIDEOS = {
  GAMEvid0001: { title: "I played Minecraft for 100 days", channel: "SomeGamer" },
  LECTvid0001: { title: "Minecraft redstone computer explained", channel: "MIT OpenCourseWare" },
  MUSICvid001: { title: "Lo-fi beats to study to", channel: "Chill Radio" },
};
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

try {
  // The relay with the fake Anthropic API.
  const mock = await startMock(KEY);
  const relay = spawn("npx", ["wrangler", "dev", "--port", RELAY_PORT, "--ip", "127.0.0.1", "--persist-to", join(work, "relay"),
    "--show-interactive-dev-session=false", "--var", `ANTHROPIC_API_KEY:${KEY}`, "--var", `ANTHROPIC_BASE_URL:http://127.0.0.1:${mock.port}`],
    { cwd: RELAY_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(relay);
  let relayLog = ""; relay.stdout.on("data", (d) => (relayLog += d)); relay.stderr.on("data", (d) => (relayLog += d));
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${RELAY_PORT}/`); break; } catch { if (i > 200) throw new Error("relay did not start\n" + relayLog); await sleep(300); }
  }

  // A stand-in YouTube: watch pages and the oEmbed address Gatekeeper asks for a title and channel.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=www.youtube.com",
    "-addext", "subjectAltName=DNS:www.youtube.com,DNS:youtube.com", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
  const oembedAsked = [];
  const yt = createServer({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) }, (req, res) => {
    const u = new URL(req.url, "https://www.youtube.com");
    if (u.pathname === "/oembed") {
      const id = new URL(u.searchParams.get("url")).searchParams.get("v");
      oembedAsked.push(id);
      const v = VIDEOS[id];
      res.writeHead(v ? 200 : 404, { "content-type": "application/json" });
      res.end(v ? JSON.stringify({ title: v.title, author_name: v.channel }) : "{}");
      return;
    }
    const v = VIDEOS[u.searchParams.get("v")] || { title: "Home" };
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>${v.title} - YouTube</title><h1>${v.title}</h1>`);
  });
  await new Promise((r) => yt.listen(0, "127.0.0.1", r));
  children.push({ kill: () => yt.close() });

  const ext = join(work, "extension");
  cpSync(fileURLToPath(new URL("../../extension", import.meta.url)), ext, { recursive: true });
  const config = join(ext, "config.js");
  writeFileSync(config, readFileSync(config, "utf8").replace(/export const RELAY_URL = ".*";/, `export const RELAY_URL = "http://localhost:${RELAY_PORT}";`));
  const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  m.host_permissions.push("http://localhost/*");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));

  const port = yt.address().port;
  const browser = spawn(BROWSER, ["--headless=new", `--user-data-dir=${join(work, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", `--load-extension=${ext}`, `--remote-debugging-port=${CDP_PORT}`,
    `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${port}, MAP youtube.com 127.0.0.1:${port}`, "--ignore-certificate-errors", "about:blank"],
    { stdio: "ignore" });
  children.push(browser);

  // Welcome: only games is watched, so YouTube itself has no limit.
  const p = await connect((t) => t.type === "page" && t.url.endsWith("/pages/welcome.html"), CDP_PORT);
  await sleep(600);
  await p.evaluate(`document.querySelector('.kind[data-kind=games]').click()`);
  await sleep(300);
  await p.evaluate(`document.getElementById('start').click()`);
  await sleep(800);
  const sw = await connect((t) => t.type === "service_worker", CDP_PORT);
  const st = () => sw.evaluate(`chrome.storage.local.get('state').then(r => r.state)`);
  await p.send("Page.enable");

  // The chat: nothing is sent before the yes; then a card with two lines, both now.
  const rulesUrl = await sw.evaluate(`chrome.runtime.getURL("pages/rules.html")`);
  const talkUrl = await sw.evaluate(`chrome.runtime.getURL("pages/talk.html?from=rules")`);
  await p.send("Page.navigate", { url: talkUrl }); await sleep(1200);
  const before = mock.requests.length;
  await p.evaluate(`document.getElementById('chat-message').value = 'block YouTube videos about video games but keep educational ones'; document.getElementById('chat-form').requestSubmit();`);
  await sleep(600);
  check("before the yes, the chat's consent text shows and nothing is sent",
    !(await p.evaluate(`document.getElementById('chat-consent').classList.contains('hidden')`)) && mock.requests.length === before);
  await p.evaluate(`document.getElementById('chat-yes').click()`);
  await sleep(2000);
  const card = await p.evaluate(`document.getElementById('card').innerText`);
  check("the card shows both video rules, applying now", /video games.*closed/i.test(card) && /educational.*free/i.test(card) && (card.match(/NOW/gi) || []).length === 2, card);
  const chatReq = mock.requests.filter((r) => r.body.system?.includes("You change the rules")).at(-1);
  check("Claude saw the sentence and the rules, not today's minutes", /video games but keep educational/.test(chatReq.body.messages[0].content) && !/seconds/.test(chatReq.body.messages[0].content));
  let s = await st();
  check("nothing changed before Apply", s.rules.videos.length === 0, s.rules.videos);
  await p.evaluate(`document.getElementById('apply').click()`);
  await sleep(1200);
  s = await st();
  check("Apply made two video rules and recorded the yes to judging", s.rules.videos.length === 2 && s.consent.help === 1, { videos: s.rules.videos, consent: s.consent });
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(1200);
  const listed = await p.evaluate(`(document.getElementById('video-rules') || {}).innerText || ''`);
  check("the rules page lists them as chips under Video", /video games.*closed/i.test(listed) && /educational.*free/i.test(listed), listed);

  // A game video: judged by Claude from its title and channel, then sent to the gate.
  await p.send("Page.navigate", { url: watch("GAMEvid0001") });
  for (let i = 0; i < 10 && !short(await p.evaluate("location.href")).startsWith("ext:"); i++) await sleep(1000);
  check("the game video goes to the gate", short(await p.evaluate("location.href")).startsWith("ext:/pages/gate.html#" + watch("GAMEvid0001")), await p.evaluate("location.href"));
  await sleep(800);
  const gate = await p.evaluate(`document.getElementById('headline').textContent + ' | ' + document.getElementById('used').textContent`);
  check("the gate names the video rule and does not offer to talk", /This video is closed/.test(gate) && /video games/.test(gate) && await p.evaluate(`document.getElementById('form').classList.contains('hidden')`), gate);
  const judgeReq = mock.requests.filter((r) => r.body.system?.includes("You judge single videos")).at(-1);
  const sentText = judgeReq.body.messages[0].content;
  check("Claude saw the title, the channel and the rules' wording, never the address", /I played Minecraft/.test(sentText) && /SomeGamer/.test(sentText) && /about: video games/.test(sentText) && !/watch\?v=|GAMEvid/.test(sentText), sentText);

  // An educational video: let through, and not counted against Video.
  await p.send("Page.navigate", { url: watch("LECTvid0001") });
  await sleep(7000);
  check("the lecture stays open", (await p.evaluate("location.href")).startsWith(watch("LECTvid0001")), await p.evaluate("location.href"));
  s = await st();
  check("judged under the educational rule by Claude", s.judged["yt:LECTvid0001"]?.rule === "v2" && s.judged["yt:LECTvid0001"]?.by === "claude", s.judged);

  // The game video again: stopped before it loads now that it is judged.
  await p.send("Page.navigate", { url: watch("GAMEvid0001") });
  await sleep(800);
  check("a judged game video is stopped before it loads", short(await p.evaluate("location.href")).startsWith("ext:/pages/gate.html"), await p.evaluate("location.href"));

  // Close Video entirely (a tightening, so now): the lecture still opens; an unjudged video does not.
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(1200);
  await p.evaluate(`document.querySelector('[data-add=video]').click()`); await sleep(1500);
  for (let i = 0; i < 3; i++) { await p.evaluate(`document.querySelector('[data-kind=video] [data-step="-1"]').click()`); await sleep(120); }
  await sleep(1500);
  await sleep(1200);
  s = await st();
  check("Video is closed all day, at once", s.rules.kinds.video?.minutes === 0, s.rules.kinds);
  await p.send("Page.navigate", { url: watch("LECTvid0001") });
  await sleep(2500);
  check("with YouTube closed, the educational video still opens", (await p.evaluate("location.href")).startsWith(watch("LECTvid0001")), await p.evaluate("location.href"));
  await p.send("Page.navigate", { url: watch("MUSICvid001") });
  await sleep(6000);
  const music = await p.evaluate(`location.href + ' | ' + (document.getElementById('headline') || {}).textContent`);
  check("an unjudged video waits at the gate, is judged, and stays closed with Video", /gate\.html/.test(music) && /Closed all day/.test(music), music);
  s = await st();
  check("it was judged under no rule", s.judged["yt:MUSICvid001"] && s.judged["yt:MUSICvid001"].rule === null, s.judged["yt:MUSICvid001"]);

  // Turning judging off forgets what Claude judged.
  await p.send("Page.navigate", { url: rulesUrl }); await sleep(1200);
  await p.evaluate(`document.getElementById('help').click()`); await sleep(1200);
  s = await st();
  check("judging off: no yes kept, and Claude's judgments forgotten", !s.consent.judge && !Object.values(s.judged).some((j) => j.by === "claude"), { consent: s.consent, judged: s.judged });
  check("YouTube was asked for titles only by video ID", oembedAsked.length >= 3 && oembedAsked.every((id) => id in VIDEOS), oembedAsked);
} catch (e) {
  console.log("FAIL", e.message);
  failures++;
}
console.log(failures ? `${failures} failed` : "e2e videos ok");
process.exit(failures ? 1 : 0);
