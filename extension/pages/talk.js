// Change something: the rules chat. Claude proposes a change as a card; nothing changes until Apply, and
// Apply goes through proposeRules, so a loosening is tagged "tomorrow" and waits for the morning.
import { ask, el, clock, lockIcon, clockIcon, whatsSent, checkWorker } from "./common.js";

const $ = (id) => document.getElementById(id);
const inTab = new URLSearchParams(location.search).get("from") === "rules";
if (inTab) {
  document.body.classList.remove("popup");
  $("talk-main").className = "page narrow";
  $("talk-main").style.minHeight = "100vh";
  $("back").href = "rules.html";
}

let history = []; // this conversation: { role: "user" | "gatekeeper", text }, kept only on this screen
let helpOn = false;
let card = null;
let reasonFor = false; // after Apply with a loosening: the next message is the reason, for the agent

function say(text, me) {
  const b = el("div", { class: "bubble" + (me ? " me" : "") }, text);
  $("chat-log").append(b);
  b.scrollIntoView({ block: "end" });
}

$("consent-list").append(whatsSent());

$("suggest").addEventListener("click", (e) => {
  const b = e.target.closest(".suggest");
  if (!b) return;
  $("chat-message").value = b.textContent;
  $("chat-form").requestSubmit();
});

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-message").value.trim();
  if (!text) return;
  if (reasonFor) { sendReason(text); return; }
  if (!helpOn) {
    // Nothing leaves the browser before this yes.
    $("chat-consent").classList.remove("hidden");
    $("chat-form").classList.add("hidden");
    $("suggest").classList.add("hidden");
    return;
  }
  send(text);
});

$("chat-yes").addEventListener("click", async () => {
  // Sorting new sites comes with Claude help where the browser lets Gatekeeper see every site; it asks here.
  await chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
  const r = await ask("consent", { help: true }).catch(() => null);
  $("chat-consent").classList.add("hidden");
  $("chat-form").classList.remove("hidden");
  helpOn = !!(r && r.help);
  if (helpOn) send($("chat-message").value.trim());
  else say("That wasn't saved, so nothing was sent.");
});

$("chat-no").addEventListener("click", () => {
  $("chat-consent").classList.add("hidden");
  $("chat-form").classList.remove("hidden");
  say("Then nothing is sent. Your rules page changes things by hand.");
});

async function send(text) {
  if (!text) return;
  say(text, true);
  $("chat-message").value = "";
  $("suggest").classList.add("hidden");
  if (card) { card.remove(); card = null; }
  $("chat-send").disabled = $("chat-message").disabled = true;
  let r;
  try { r = await ask("chat", { message: text, history }); } catch { r = { failed: "unreachable" }; }
  $("chat-send").disabled = $("chat-message").disabled = false;
  $("chat-message").focus();
  history.push({ role: "user", text });
  if (r.refused === "no_consent") { helpOn = false; $("chat-consent").classList.remove("hidden"); $("chat-form").classList.add("hidden"); return; }
  if (r.failed) {
    say(r.failed === "daily_limit" ? "That's enough changes by talking for today." : "Can't reach Claude right now. Your rules page still works.");
    return;
  }
  const answer = r.question || r.reply;
  if (answer) { say(answer); history.push({ role: "gatekeeper", text: answer }); }
  if (!r.question) showCard(r);
}

async function sendReason(text) {
  say(text, true);
  $("chat-message").value = "";
  const r = await ask("loosen", { message: text }).catch(() => ({ decision: "unavailable" }));
  if (r.decision === "ask") { say(r.reply); return; }
  reasonFor = false;
  $("chat-message").placeholder = "Say it in your words";
  if (r.decision === "allow") say(`${r.reply} It applies tomorrow at ${clock(r.from)}.`);
  else if (r.decision === "deny") say(`${r.reply} You can ask again tomorrow.`);
  else if (r.decision === "unavailable") say("I couldn't be reached, so it waits for the morning as usual.");
  else say("Nothing was sent.");
}

function line(text, later, from) {
  return el("div", { class: "line" },
    el("span", { class: "icon " + (later ? "later" : "now") }, later ? clockIcon(16) : lockIcon(16, "")),
    el("span", {}, text),
    el("span", { class: "tag " + (later ? "later" : "now") }, later ? "tomorrow" : "now"));
}

function showCard(p) {
  if (!p.now.length && !p.later.length) { say("That changes nothing in your rules."); return; }
  const rows = [...p.now.map((c) => line(c.text, false)), ...p.later.map((c) => line(c.text, true, p.from))];
  if (p.later.length) rows.push(el("div", { class: "small muted" }, `"Tomorrow" means ${clock(p.from)} tomorrow morning. For a real need now, ask the gate.`));
  if (p.needsAccess.length) rows.push(el("div", { class: "small muted" }, `Your browser will ask to let Gatekeeper see ${p.needsAccess.join(", ")}.`));
  if (p.skipped) rows.push(el("div", { class: "small muted" }, `${p.skipped} part${p.skipped === 1 ? "" : "s"} of the answer couldn't be used.`));
  const apply = el("button", { class: "btn", type: "button", id: "apply" }, "Apply");
  const not = el("button", { class: "btn ghost", type: "button", id: "not-this" }, "Not this");
  card = el("div", { class: "change", id: "card" }, ...rows, el("div", { class: "actions" }, apply, not));
  $("chat-log").append(card);
  card.scrollIntoView({ block: "end" });
  not.addEventListener("click", () => { card.remove(); card = null; say("Nothing changed."); });
  apply.addEventListener("click", async () => {
    if (p.needsAccess.length) {
      const granted = await chrome.permissions.request({ origins: p.needsAccess.map((d) => `*://*.${d}/*`) });
      if (!granted) { say(`Gatekeeper needs access to ${p.needsAccess.join(", ")}. Nothing changed.`); card.remove(); card = null; return; }
    }
    const r = await ask("propose", { rules: p.rules });
    card.remove(); card = null;
    if (r.refused === "asked_today") { say("I said no to that today. You can ask again tomorrow."); return; }
    if (r.needsOk) {
      say(`${r.now.length ? "The stricter part applies now. " : ""}To loosen the rest, tell me why: what changed?`);
      reasonFor = true;
      $("chat-message").placeholder = "Your reason, in one go";
      $("chat-message").focus();
      return;
    }
    say(r.later && r.later.length ? `Done. ${r.now.length ? "Some of it applies now; the rest " : "It "}applies tomorrow at ${clock(r.from)}.` : "Done. It applies now.");
  });
}

async function load() {
  const { consent = {} } = await ask("state");
  helpOn = !!(consent.help && consent.help.on) || !!(consent.chat && consent.chat.on);
}

checkWorker();
load();
