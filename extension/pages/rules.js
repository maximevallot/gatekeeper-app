import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, label } from "../engine/engine.js";
import { videoName, videoMinutesText } from "../engine/videos.js";
import { ask, el, when, checkWorker, warnings } from "./common.js";

const $ = (id) => document.getElementById(id);
let draft = null; // the rules being edited: { kinds, sites, videos, dayStart }

let warned = false;
async function load() {
  const got = await ask("state");
  const { state, now } = got;
  if (!warned) warned = warnings(got, document.querySelector("h1").nextElementSibling.nextElementSibling) >= 0;
  draft = structuredClone(state.pending ? state.pending.rules : state.rules);
  $("goal").value = state.goal || "";
  renderPending(state, now);
  renderKinds(state);
  renderSites();
  renderVideos(state);
}

function renderVideos(state) {
  const list = draft.videos || [];
  $("videos").replaceChildren(...(list.length ? list.map((v) => {
    const used = Math.floor(((state.usage.seconds || {})["v:" + v.id] || 0) / 60);
    const today = v.minutes > 0 ? ` · ${used} of ${v.minutes} min used today` : "";
    return el("div", { class: "row" },
      el("div", { class: "name" }, el("div", {}, `Videos about ${videoName(v)}`),
        el("div", { class: "muted" }, (v.except ? `except ${v.except} · ` : "") + videoMinutesText(v.minutes) + today)),
      el("button", { class: "link", type: "button", onclick: () => { draft.videos = draft.videos.filter((x) => x.id !== v.id); renderVideos(state); } }, "Remove"));
  }) : [el("p", { class: "muted" }, "None yet. Try the chat: \"block YouTube videos about video games but keep educational ones\".")]));
}

function renderPending(state, now) {
  const p = state.pending;
  $("pending").classList.toggle("hidden", !p);
  if (!p) return;
  $("pending").replaceChildren(
    `Waiting until ${when(p.from, now)}: your changes that loosen a rule. Until then, today's rules hold. `,
    el("button", { class: "link", type: "button", onclick: keepToday }, "Keep today's rules"));
}

async function keepToday() {
  const { state } = await ask("state");
  await ask("propose", { rules: state.rules });
  flash("Kept today's rules. Nothing is waiting.");
  load();
}

function renderKinds(state) {
  const inForce = state.rules.kinds;
  $("kinds").replaceChildren(...KIND_ORDER.map((kind) => {
    const on = !!draft.kinds[kind];
    const box = el("input", { type: "checkbox", "data-kind": kind, "aria-label": "Watch " + KINDS[kind].label });
    box.checked = on;
    const minutes = el("input", { type: "number", min: "0", max: "600", step: "5", "data-kind": kind,
      value: String(on ? draft.kinds[kind].minutes : DEFAULT_MINUTES) });
    minutes.disabled = !on;
    box.addEventListener("change", () => {
      if (box.checked) draft.kinds[kind] = { minutes: Number(minutes.value) || 0 };
      else delete draft.kinds[kind];
      minutes.disabled = !box.checked;
    });
    minutes.addEventListener("input", () => { if (draft.kinds[kind]) draft.kinds[kind].minutes = Math.max(0, Number(minutes.value) || 0); });
    const used = Math.floor(((state.usage.seconds || {})[kind] || 0) / 60);
    const now = inForce[kind] ? `${used} of ${inForce[kind].minutes} min used today` : "not watched today";
    return el("div", { class: "row" }, box,
      el("div", { class: "name" }, el("div", {}, KINDS[kind].label), el("div", { class: "muted" }, now)),
      minutes, el("span", { class: "muted" }, "min a day"));
  }));
  $("new-kind").replaceChildren(...KIND_ORDER.map((k) => el("option", { value: k }, KINDS[k].label)));
}

function renderSites() {
  const entries = Object.entries(draft.sites || {}).sort();
  $("sites").replaceChildren(...(entries.length ? entries.map(([domain, kind]) =>
    el("div", { class: "row" }, el("div", { class: "name" }, domain), el("span", { class: "muted" }, label(kind)),
      el("button", { class: "link", type: "button", onclick: () => { delete draft.sites[domain]; renderSites(); } }, "Remove")))
    : [el("p", { class: "muted" }, "None yet.")]));
}

$("add-site").addEventListener("click", () => {
  let d = $("new-site").value.trim().toLowerCase();
  try { d = new URL(d.includes("://") ? d : "https://" + d).hostname.replace(/^www\./, ""); } catch { return; }
  if (!d.includes(".")) return;
  const kind = $("new-kind").value;
  // Gatekeeper may act only on the sites in its catalog; any other site is asked for here, one at a time,
  // and the browser asks the user. The request has to start inside the click.
  chrome.permissions.request({ origins: [`*://*.${d}/*`] }).then((granted) => {
    if (!granted) {
      flash(`Gatekeeper needs access to ${d} to count time there and close it. Nothing was added.`);
      return;
    }
    draft.sites = { ...(draft.sites || {}), [d]: kind };
    $("new-site").value = "";
    renderSites();
    flash(`${d} will count as ${label(kind).toLowerCase()} once you save.`);
  });
});

function flash(text, list = []) {
  $("result").replaceChildren(text, ...(list.length ? [el("ul", { class: "changes" }, ...list.map((t) => el("li", {}, t)))] : []));
  $("result").classList.remove("hidden");
}

$("save").addEventListener("click", async () => {
  const r = await ask("propose", { rules: draft, goal: $("goal").value });
  const parts = [];
  if (r.now.length) parts.push("Applied now: " + r.now.map((c) => c.text).join("; ") + ".");
  if (r.later.length) parts.push(`Takes effect ${when(r.from)}: ` + r.later.map((c) => c.text).join("; ") + ".");
  flash(parts.join(" ") || "Saved.");
  load();
});

load();

// ---------- the rules chat ----------

let history = []; // this conversation: { role: "user" | "gatekeeper", text }, kept only on this page
let consent = {}; // switch -> { on, outdated }, as the background last said

function say(text, me) {
  $("chat-log").append(el("div", { class: "msg" + (me ? " me" : "") }, text));
}

$("chat-message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); }
});

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-message").value.trim();
  if (!text) return;
  if (!(consent.chat && consent.chat.on)) {
    // Nothing leaves the browser before this yes.
    $("chat-consent").classList.remove("hidden");
    $("chat-form").classList.add("hidden");
    return;
  }
  sendChat(text);
});

$("chat-yes").addEventListener("click", async () => {
  const r = await saveConsent({ chat: true });
  $("chat-consent").classList.add("hidden");
  $("chat-form").classList.remove("hidden");
  if (r && r.chat) sendChat($("chat-message").value.trim());
});

$("chat-no").addEventListener("click", () => {
  $("chat-consent").classList.add("hidden");
  $("chat-form").classList.remove("hidden");
  say("Then nothing is sent. The boxes below still change your rules.");
});

async function sendChat(text) {
  if (!text) return;
  say(text, true);
  $("chat-message").value = "";
  $("card").classList.add("hidden");
  $("chat-send").disabled = $("chat-message").disabled = true;
  let r;
  try { r = await ask("chat", { message: text, history }); } catch { r = { failed: "unreachable" }; }
  $("chat-send").disabled = $("chat-message").disabled = false;
  history.push({ role: "user", text });
  if (r.refused === "no_consent") { $("chat-consent").classList.remove("hidden"); $("chat-form").classList.add("hidden"); return; }
  if (r.failed) {
    say(r.failed === "daily_limit" ? "That is enough rule changes by chat for today. The boxes below still work." : "Can't reach Claude right now. The boxes below still work.");
    return;
  }
  const answer = r.question || r.reply;
  if (answer) { say(answer); history.push({ role: "gatekeeper", text: answer }); }
  if (r.question) { $("chat-message").focus(); return; }
  showCard(r);
}

function showCard(p) {
  const card = $("card");
  if (!p.now.length && !p.later.length) {
    say("That changes nothing in your rules.");
    card.classList.add("hidden");
    return;
  }
  const line = (c, tag, cls) => el("div", {}, el("span", { class: "when" + (cls ? " " + cls : "") }, tag), c.text);
  const addsVideos = (p.rules.videos || []).length > ((draft && draft.videos) || []).length;
  const rows = [
    ...p.now.map((c) => line(c, "Now")),
    ...p.later.map((c) => line(c, when(p.from), "later")),
  ];
  if (p.later.length) rows.push(el("p", { class: "muted" }, "Loosening always waits until the next morning. For a real need now, open the site and talk to the gate."));
  if (p.needsAccess.length) rows.push(el("p", { class: "muted" }, `Your browser will ask to let Gatekeeper see ${p.needsAccess.join(", ")}.`));
  if (p.skipped) rows.push(el("p", { class: "muted" }, `${p.skipped} part${p.skipped === 1 ? "" : "s"} of the answer could not be used and ${p.skipped === 1 ? "is" : "are"} left out.`));
  const actions = el("div", { class: "actions" });
  const done = () => { card.classList.add("hidden"); };
  const apply = async (judge) => {
    if (p.needsAccess.length) {
      const granted = await chrome.permissions.request({ origins: p.needsAccess.map((d) => `*://*.${d}/*`) });
      if (!granted) { say(`Gatekeeper needs access to ${p.needsAccess.join(", ")} to count time there and close it. Nothing was changed.`); done(); return; }
    }
    if (judge !== undefined) await saveConsent({ judge });
    const r = await ask("propose", { rules: p.rules });
    const parts = [];
    if (r.now.length) parts.push("Applied now: " + r.now.map((c) => c.text).join("; ") + ".");
    if (r.later.length) parts.push(`Takes effect ${when(r.from)}: ` + r.later.map((c) => c.text).join("; ") + ".");
    flash(parts.join(" ") || "Saved.");
    say("Applied.");
    done();
    load();
  };
  if (addsVideos && !(consent.judge && consent.judge.on)) {
    // The first video rule asks how videos are judged: the user's yes before any title is sent.
    rows.push(el("p", {}, "How should Gatekeeper tell which videos a rule covers? Claude judges each video you open on YouTube from its title and channel (sent with your rules' wording, never the address), or this browser matches words, which is rougher and sends nothing."));
    actions.append(
      el("button", { class: "primary", type: "button", onclick: () => apply(true) }, "Apply, Claude judges"),
      el("button", { class: "link", type: "button", onclick: () => apply(false) }, "Apply, words only"));
  } else {
    actions.append(el("button", { class: "primary", type: "button", onclick: () => apply() }, "Apply"));
  }
  actions.append(el("button", { class: "link", type: "button", onclick: () => { say("Nothing changed."); done(); } }, "Cancel"));
  card.replaceChildren(...rows, actions);
  card.classList.remove("hidden");
}

// ---------- Claude: four switches, each a yes to sending something ----------

const ALL_SITES = { origins: ["*://*/*"] };
const SWITCHES = { talk: "talk", sorting: "sorting", chat: "chat-switch", judge: "judge" };

function showSwitches(c) {
  consent = c;
  for (const [name, id] of Object.entries(SWITCHES)) $(id).checked = !!(c[name] && c[name].on);
  $("consent-outdated").classList.toggle("hidden", !Object.values(c).some((x) => x && x.outdated));
}

async function loadSwitches() {
  const got = await ask("state");
  showSwitches(got.consent || {});
}

// A switch shows what is saved, never just what was clicked.
async function saveConsent(change) {
  try {
    const r = await ask("consent", change);
    showSwitches(Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, { on: !!r[k], outdated: false }])));
    return r;
  } catch {
    await loadSwitches().catch(() => { for (const id of Object.values(SWITCHES)) $(id).checked = false; });
    flash("That change was not saved: Gatekeeper's background did not answer.");
    return null;
  }
}

$("talk").addEventListener("change", async () => {
  const r = await saveConsent({ talk: $("talk").checked });
  if (r) flash(r.talk ? "The gate can talk back." : "The gate no longer sends anything.");
});

$("sorting").addEventListener("change", () => {
  if ($("sorting").checked) {
    // The browser asks the user; the request has to start inside the click.
    chrome.permissions.request(ALL_SITES).then(async (granted) => {
      const r = await saveConsent({ sorting: granted });
      if (r) flash(r.sorting ? "Sites Gatekeeper doesn't know will be sorted after a minute." : "Without that permission Gatekeeper cannot see other sites, so sorting stays off.");
    });
  } else {
    saveConsent({ sorting: false }).then((r) => {
      if (!r) return;
      chrome.permissions.remove(ALL_SITES);
      flash("Sorting is off. Sites already sorted keep their kind.");
    });
  }
});

$("chat-switch").addEventListener("change", async () => {
  const r = await saveConsent({ chat: $("chat-switch").checked });
  if (r) flash(r.chat ? "The chat can send to Claude." : "The chat sends nothing.");
});

$("judge").addEventListener("change", async () => {
  const r = await saveConsent({ judge: $("judge").checked });
  if (r) flash(r.judge ? "Claude judges videos for your video rules." : "Video rules now match words on this device, and what Claude judged is forgotten.");
});

checkWorker();
loadSwitches();
