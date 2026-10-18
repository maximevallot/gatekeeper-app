// Change something: the one thread with Gatekeeper. The engine keeps it (state.thread), so the popup, this tab
// and the tab the Mac opens all show the same talk and update together. A change comes as a card; nothing
// changes until Apply, and Apply checks the card again against the rules as they are then.
import { ask, el, clock, lockIcon, clockIcon, whatsSent, checkWorker } from "./common.js";

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
  if (v.needsAccess.length) rows.push(el("div", { class: "small muted" }, `Your browser will ask to let Gatekeeper see ${v.needsAccess.join(", ")}.`));
  if (v.skipped) rows.push(el("div", { class: "small muted" }, `${v.skipped} part${v.skipped === 1 ? "" : "s"} of the answer couldn't be used.`));
  const apply = el("button", { class: "btn", type: "button", id: "apply" }, "Apply");
  const not = el("button", { class: "btn ghost", type: "button", id: "not-this" }, "Not this");
  apply.addEventListener("click", async () => {
    // A site outside the catalog needs the browser's yes first, asked inside the click.
    if (v.needsAccess.length && !(await chrome.permissions.request({ origins: v.needsAccess.map((d) => `*://*.${d}/*`) }).catch(() => false))) {
      await ask("dropCard"); return;
    }
    await ask("applyCard").catch(() => null);
  });
  not.addEventListener("click", () => ask("dropCard"));
  return el("div", { class: "change", id: "card" }, ...rows, el("div", { class: "actions" }, apply, not));
}

function render() {
  const th = (got.state.thread) || { turns: [], card: null };
  const items = th.turns.length ? th.turns.map(bubble)
    : [el("div", { class: "bubble" }, "Say what to change, in your words. Anything that loosens a rule needs a reason, and then waits for the morning.")];
  if (th.card) items.push(cardView(th.card));
  $("chat-log").replaceChildren(...items);
  $("chat-log").lastChild.scrollIntoView({ block: "end" });
  // A loosening waiting for its reason: the next message is that reason, for the agent.
  const reason = !!got.state.loosen;
  $("chat-message").placeholder = reason ? "Your reason, in one go" : "Say it in your words";
  $("suggest").classList.toggle("hidden", th.turns.length > 0 || reason);
}

let shown = "";
async function load() {
  got = await ask("state");
  // The state changes every few seconds while time is counted; redraw only when the talk itself changed.
  const key = JSON.stringify([got.state.thread, got.state.loosen, got.consent && got.consent.help]);
  if (key === shown) return;
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
  if (got.state.loosen) await ask("loosen", { message: text }).catch(() => null);
  else await ask("chat", { message: text }).catch(() => null);
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
