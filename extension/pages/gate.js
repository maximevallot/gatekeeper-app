// The gate. It says what is closed, how much was used, when it reopens, and the user's own sentence about
// what they are working toward. One box takes a real need to Claude through the relay: allow opens the
// site for a few minutes, ask allows one follow-up, and no, or any error, keeps it shut.
import { ask, when, el, clock, checkWorker, warnings, whatsSent, whatsSentToggle } from "./common.js";

const $ = (id) => document.getElementById(id);
const url = location.hash.slice(1); // the page that was stopped, exactly as it was asked for

let waits = 0;
let counted = false;
async function show() {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  const decided = await ask("decide", { url, count: !counted });
  counted = true;
  const { decision: d, goal } = decided;
  if ((decided.judging || decided.sorting) && waits++ < 6) {
    // A video being checked against the video rules, or (in exam mode) a site being sorted: ask again in a moment.
    const what = decided.judging ? "video" : "site";
    document.title = `Checking this ${what}`;
    $("headline").textContent = `Checking this ${what}…`;
    $("closed").classList.remove("hidden");
    setTimeout(show, 1500);
    return;
  }
  if (d.verdict === "allow" && /^https?:/.test(url)) {
    location.replace(url); // reopened since (a new morning), or a video rule lets it through: go back to the page
    return;
  }
  document.title = `${d.label || host} closed`;
  $("site").textContent = d.site ? `${host} · its own limit` : d.label ? `${host} · ${d.label}` : host;
  const until = `Closed until ${when(d.reopensAt).replace(/^(today|tomorrow) at (.*)$/, "$2 $1")}`;
  if (d.exam) {
    $("headline").textContent = `Exam mode until ${when(d.exam.until).replace(/^(today|tomorrow) at (.*)$/, "$2 $1")}`;
    $("used").textContent = (d.exam.goal ? `For ${d.exam.goal}. ` : "") + "Everything but study sites is closed until then.";
  } else if (d.video) {
    // A video rule, not a kind: the gate does not argue with it; the rules page changes it.
    const rule = `Your rule on ${d.video.name} videos${d.video.except ? `, except ${d.video.except}` : ""}`;
    $("headline").textContent = d.verdict === "block" ? "This video is closed" : until;
    $("used").textContent = d.verdict === "block" ? `${rule} closes it.` : `${rule}: you used its ${d.budgetMinutes} minutes today.`;
  } else if (d.verdict === "block") {
    $("headline").textContent = "Closed all day";
    $("used").textContent = `You set ${d.label.toLowerCase()} to 0 minutes.`;
  } else {
    $("headline").textContent = until;
    const m = d.budgetMinutes;
    $("used").textContent = `You used your ${m} minute${m === 1 ? "" : "s"} of ${d.label.toLowerCase()} today.`;
  }
  $("goal").textContent = goal || "";
  $("goal-box").classList.toggle("hidden", !goal);
  $("rules-link").href = chrome.runtime.getURL("pages/rules.html");
  $("closed").classList.remove("hidden");
  warnings(decided, $("closed"));
  talk = { on: decided.talk, host, kind: d.label };
  if (d.exam) {
    // In exam mode the gate gives a short pass only for a page that serves the exam.
    $("rules-link").textContent = "End exam mode early";
    $("rules-link").href = chrome.runtime.getURL("pages/rules.html#exam");
    document.querySelector('label[for="message"]').textContent = "Need it for the exam?";
    $("message").placeholder = "What on this page do you need for the exam?";
    if (decided.cooldownUntil) shut(`We already talked about this. The answer stands until ${clock(decided.cooldownUntil)}.`);
  }
  else if (d.video) shut("");
  else if (decided.cooldownUntil) shut(`We already talked about this. The answer stands until ${clock(decided.cooldownUntil)}.`);
  else $("message").focus();
}

let talk = { on: false };

function say(text, me) {
  $("log").append(el("div", { class: "bubble" + (me ? " me" : "") }, text));
}

const sent = whatsSentToggle();
$("sent-line").append(" ", sent.link);
$("sent-line").after(sent.list);
$("consent-text").append(whatsSent());

function shut(text) {
  if (text) say(text);
  $("form").classList.add("hidden");
}


$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  if (!talk.on) {
    // Nothing leaves the browser before this yes, to the full list of what Claude help sends.
    $("consent").classList.remove("hidden");
    $("form").classList.add("hidden");
    return;
  }
  send(text);
});

$("consent-yes").addEventListener("click", async () => {
  const r = await ask("consent", { help: true }).catch(() => null);
  if (!r || !r.talk) {
    $("consent").classList.add("hidden");
    shut("Can't reach the gate right now, so it stays shut.");
    return;
  }
  talk.on = true;
  $("consent").classList.add("hidden");
  $("form").classList.remove("hidden");
  send($("message").value.trim());
});

$("consent-no").addEventListener("click", () => {
  $("consent").classList.add("hidden");
  shut("Then nothing is sent, and the gate stays shut.");
});

async function send(text) {
  say(text, true);
  $("message").value = "";
  $("send").disabled = $("message").disabled = true;
  let r;
  try { r = await ask("talk", { url, message: text }); } catch { r = { decision: "error" }; }
  $("send").disabled = $("message").disabled = false;
  if (r.decision === "allow") {
    say(r.reply);
    shut(`Pass: ${r.minutes} minute${r.minutes === 1 ? "" : "s"} on ${r.site}. Opening…`);
    setTimeout(() => location.replace(url), 1500);
  } else if (r.decision === "ask") {
    say(r.reply);
    $("message").focus();
  } else if (r.decision === "deny") {
    say(r.reply);
    shut(`The gate stays shut until ${clock(r.until)}.`);
  } else if (r.decision === "refused" && r.reason === "cooldown") {
    shut(`We already talked about this. The answer stands until ${clock(r.until)}.`);
  } else if (r.decision === "refused" && r.reason === "passes_used") {
    shut(`The gate has opened ${talk.kind.toLowerCase()} three times today, so it stays shut until tomorrow.`);
  } else if (r.decision === "refused" && r.reason === "video_rule") {
    shut("A video rule is changed on your rules page, not here.");
  } else if (r.decision === "refused" && r.reason === "open") {
    location.replace(url);
  } else if (r.error === "daily_limit") {
    shut("The gate has answered enough for today, so it stays shut.");
  } else {
    shut("Can't reach the gate right now, so it stays shut.");
  }
}

checkWorker();
show();
