// The gate. It says what is closed, how much was used, when it reopens, and the user's own sentence about
// what they are working toward. One box takes a real need to Claude through the relay: allow opens the
// site for a few minutes, ask allows one follow-up, and no, or any error, keeps it shut.
import { ask, when, el, checkWorker, warnings } from "./common.js";

const $ = (id) => document.getElementById(id);
const url = location.hash.slice(1); // the page that was stopped, exactly as it was asked for

async function show() {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  const decided = await ask("decide", { url });
  const { decision: d, goal } = decided;
  if (d.verdict === "allow" && /^https?:/.test(url)) {
    location.replace(url); // reopened since (a new morning): go back to the page
    return;
  }
  document.title = `${d.label || host} closed`;
  $("site").textContent = d.label ? `${host} · ${d.label}` : host;
  if (d.verdict === "block") {
    $("headline").textContent = "Closed all day";
    $("used").textContent = `You set ${d.label.toLowerCase()} to 0 minutes. It stays closed until you change that rule, which takes effect the next morning.`;
  } else {
    $("headline").textContent = "Closed for today";
    const m = d.budgetMinutes;
    $("used").textContent = `You used your ${m} minute${m === 1 ? "" : "s"}. It opens again ${when(d.reopensAt)}.`;
  }
  $("goal").textContent = goal || "";
  $("goal-box").classList.toggle("hidden", !goal);
  $("rules-link").href = chrome.runtime.getURL("pages/rules.html");
  $("closed").classList.remove("hidden");
  warnings(decided, $("closed"));
  talk = { on: decided.talk, host, kind: d.label };
  if (decided.cooldownUntil) shut(`We already talked about this. The answer stands until ${clock(decided.cooldownUntil)}.`);
  else $("message").focus();
}

let talk = { on: false };
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function say(text, me) {
  $("log").append(el("div", { class: "msg" + (me ? " me" : "") }, text));
}

function shut(text) {
  if (text) say(text);
  $("form").classList.add("hidden");
}

$("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); }
});

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("message").value.trim();
  if (!text) return;
  if (!talk.on) {
    // Nothing leaves the browser before this yes.
    $("consent-text").textContent = `To answer, Gatekeeper sends ${talk.host}, that it is ${talk.kind.toLowerCase()}, ` +
      "today's minutes and budget, your goal sentence, what you typed and a random install number to Gatekeeper's relay, which asks Anthropic's Claude " +
      "and keeps none of it. Nothing else leaves this browser. You can turn this off in your rules.";
    $("consent").classList.remove("hidden");
    $("form").classList.add("hidden");
    return;
  }
  send(text);
});

$("consent-yes").addEventListener("click", async () => {
  const r = await ask("consent", { talk: true }).catch(() => null);
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
