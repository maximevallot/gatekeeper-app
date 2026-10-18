// Change something: the one thread with Gatekeeper. The engine keeps it (state.thread), so the popup, this tab
// and the tab the Mac opens all show the same talk and update together. A change comes as a card; nothing
// changes until Apply, and Apply checks the card again against the rules as they are then.
import { ask, el, clock, lockIcon, clockIcon, whatsSent, checkWorker, askEverySite } from "./common.js";

const $ = (id) => document.getElementById(id);
const inTab = new URLSearchParams(location.search).get("from") === "rules" || window.innerWidth > 520;
if (inTab) {
  document.body.classList.remove("popup");
  $("talk-main").className = "page narrow";
  $("talk-main").style.minHeight = "100vh";
  $("back").href = "rules.html";
}

let got = null; // the background's last state reply
let busy = false;

const helpOn = () => {
  const c = (got && got.consent) || {};
  return !!(c.help && c.help.on) || !!(c.chat && c.chat.on);
};

function bubble(t) {
  if (t.role === "note") return el("div", { class: "small muted", style: "align-self: center" }, t.text);
  return el("div", { class: "bubble" + (t.role === "user" ? " me" : "") }, t.text);
}

function line(text, later, agent) {
  return el("div", { class: "line" },
    el("span", { class: "icon " + (later ? "later" : "now") }, later ? clockIcon(16) : lockIcon(16, "")),
    el("span", {}, text),
    el("span", { class: "tag " + (later ? "later" : "now") }, agent ? "asks you why" : later ? "tomorrow" : "now"));
}

function cardView(c) {
  const v = c.view;
  const rows = [...v.now.map((t) => line(t, false)), ...v.later.map((x) => line(x.text, true, x.agent))];
  if (v.later.some((x) => !x.agent)) rows.push(el("div", { class: "small muted" }, `"Tomorrow" means ${clock(v.from)} tomorrow morning, once you've said why.`));
  if (v.needsAccess.length) {
    const note = el("div", { class: "small muted" }, `Your browser will ask to let Gatekeeper see ${v.needsAccess.join(", ")}.`);
    chrome.permissions.contains({ origins: v.needsAccess.map((d) => `*://*.${d}/*`) }).then((has) => { if (has) note.remove(); }, () => {});
    rows.push(note);
  }
  if (v.skipped) rows.push(el("div", { class: "small muted" }, `${v.skipped} part${v.skipped === 1 ? "" : "s"} of the answer couldn't be used.`));
  const apply = el("button", { class: "btn", type: "button", id: "apply" }, "Apply");
  const not = el("button", { class: "btn ghost", type: "button", id: "not-this" }, "Not this");
  apply.addEventListener("click", async () => {
    // Exam mode from the chat asks for access to every site too, inside this click (QA round 3, N3).
    if ((c.answer.diff || []).some((op) => op && op.op === "examStart")) await askEverySite();
    // A site outside the catalog needs the browser's yes first, asked inside the click.
    // Only what the browser has not granted yet is asked for.
    const origins = v.needsAccess.map((d) => `*://*.${d}/*`);
    const have = origins.length ? await chrome.permissions.contains({ origins }).catch(() => false) : true;
    if (!have && !(await chrome.permissions.request({ origins }).catch(() => false))) {
      await ask("dropCard"); return;
    }
    await ask("applyCard").catch(() => null);
  });
  not.addEventListener("click", () => ask("dropCard"));
  return el("div", { class: "change", id: "card" }, ...rows, el("div", { class: "actions" }, apply, not));
}

// A loosening waiting for its reason gets a box of its own (QA round 2, chat C1): the chat box below always
// talks about rules, so "also limit reddit to 10" is never taken as the reason. "Not now" keeps the change
// waiting; "Drop it" cancels the change.
function reasonBox(l) {
  const text = el("textarea", { class: "field", id: "reason-message", rows: 2, maxlength: 500, placeholder: "Why? Your reason, in one go", "aria-label": "Your reason" });
  const sendIt = el("button", { class: "btn", type: "button", id: "reason-send" }, "Send reason");
  const later = el("button", { class: "btn ghost", type: "button", id: "reason-later" }, "Not now");
  const drop = el("button", { class: "link", type: "button", id: "reason-drop" }, l.kind === "exam" ? "Keep exam mode" : "Drop this change");
  sendIt.addEventListener("click", async () => {
    const m = text.value.trim();
    if (!m || busy) return;
    busy = true; sendIt.disabled = true;
    await ask("loosen", { message: m }).catch(() => null);
    busy = false; reasonHidden = false;
    await load(true);
  });
  later.addEventListener("click", () => { reasonHidden = true; render(); });
  drop.addEventListener("click", async () => { await ask("dropLoosen").catch(() => null); await load(true); });
  const what = l.kind === "exam" ? "End exam mode early" : l.changes.join("; ");
  return el("div", { class: "change", id: "reason" },
    el("div", { class: "small" }, l.asked ? l.asked : `To loosen this, tell Gatekeeper why: ${what}.`),
    text, el("div", { class: "actions" }, sendIt, later, drop));
}
let reasonHidden = false;

function render() {
  const th = (got.state.thread) || { turns: [], card: null };
  const items = th.turns.length ? th.turns.map(bubble)
    : [el("div", { class: "bubble" }, "Say what to change, in your words. Anything that loosens a rule needs a reason, and then waits for the morning.")];
  if (th.card) items.push(cardView(th.card));
  const l = got.state.loosen;
  if (l && !reasonHidden) items.push(reasonBox(l));
  else if (l) {
    const open = el("button", { class: "link", type: "button", id: "reason-open" }, "Give your reason");
    open.addEventListener("click", () => { reasonHidden = false; render(); });
    items.push(el("div", { class: "small muted", style: "align-self: center" }, "A change is waiting for your reason. ", open));
  }
  $("chat-log").replaceChildren(...items);
  $("chat-log").lastChild.scrollIntoView({ block: "end" });
  $("suggest").classList.toggle("hidden", th.turns.length > 0 || !!l);
}

let shown = "";
async function load(force = false) {
  got = await ask("state");
  // The state changes every few seconds while time is counted; redraw only when the talk itself changed.
  const key = JSON.stringify([got.state.thread, got.state.loosen, got.consent && got.consent.help]);
  if (key === shown && !force) return;
  shown = key;
  render();
}

$("consent-list").append(whatsSent());

$("suggest").addEventListener("click", (e) => {
  const b = e.target.closest(".suggest");
  if (!b) return;
  $("chat-message").value = b.textContent;
  $("chat-form").requestSubmit();
});

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("chat-message").value.trim();
  if (!text || busy) return;
  if (!helpOn()) {
    // Nothing leaves the browser before this yes.
    $("chat-consent").classList.remove("hidden");
    $("chat-form").classList.add("hidden");
    $("suggest").classList.add("hidden");
    return;
  }
  send(text);
});

async function send(text) {
  busy = true;
  $("chat-message").value = "";
  $("chat-send").disabled = $("chat-message").disabled = true;
  await ask("chat", { message: text }).catch(() => null);
  busy = false;
  $("chat-send").disabled = $("chat-message").disabled = false;
  $("chat-message").focus();
  await load();
}

$("chat-yes").addEventListener("click", async () => {
  // Sorting new sites comes with Claude help where the browser lets Gatekeeper see every site; it asks here.
  await chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
  const r = await ask("consent", { help: true }).catch(() => null);
  $("chat-consent").classList.add("hidden");
  $("chat-form").classList.remove("hidden");
  await load();
  if (r && r.help) send($("chat-message").value.trim() || "");
});

$("chat-no").addEventListener("click", () => {
  $("chat-consent").classList.add("hidden");
  $("chat-form").classList.remove("hidden");
});

$("forget").addEventListener("click", async () => { await ask("forgetThread"); await load(); });

// Every view of the thread updates when the engine's state changes, whichever tab changed it.
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.state && !busy) load(); });

checkWorker();
load();
