// The hands, in the browser. They report the page in front and enforce what the engine decides; they
// decide nothing. The state lives in chrome.storage.local, and only this worker writes it, one change
// at a time. The only network calls go to the relay (hands/relay.js), and only after the user said yes.

import * as engine from "../engine/engine.js";
import { buildRules } from "./blocker.js";
import { callRelay } from "./relay.js";
import { PROTOCOL } from "../protocol.js";

const TICK_MS = 2000;
const IDLE_SECONDS = 60; // no keyboard or mouse for a minute, and nothing playing: you are away
const GATE = chrome.runtime.getURL("pages/gate.html");
const ALL_SITES = { origins: ["*://*/*"] }; // granted only when the user turns on sorting

let state = null;
let queue = Promise.resolve();
let blocking = null; // the closed domains last written into the redirect rules
let lastTick = Date.now();

async function load() {
  if (!state) {
    state = engine.upgrade((await chrome.storage.local.get("state")).state);
    if (!state.installId) {
      state = { ...state, installId: crypto.randomUUID() };
      await chrome.storage.local.set({ state });
    }
  }
  return state;
}

/** Run one engine step on the state, save it if it changed, and bring the redirect rules up to date. */
function update(step) {
  const run = queue.then(async () => {
    const before = await load();
    const out = (await step(before)) || {};
    if (out.state && out.state !== before) {
      state = out.state;
      await chrome.storage.local.set({ state });
    }
    await syncBlocking();
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

async function syncBlocking() {
  const domains = engine.closedDomains(state, Date.now());
  const key = domains.join(" ");
  if (key === blocking) return;
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: buildRules(domains, GATE),
  });
  blocking = key;
}

function gateUrl(url) {
  return GATE + "#" + url;
}

async function frontTab() {
  try {
    const win = await chrome.windows.getLastFocused({});
    if (!win.focused) return { focused: false, tab: null };
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return { focused: true, tab: tab || null };
  } catch {
    return { focused: false, tab: null };
  }
}

async function tick() {
  const now = Date.now();
  const seconds = Math.min((now - lastTick) / 1000, engine.MAX_TICK_SECONDS);
  lastTick = now;
  const { focused, tab } = await frontTab();
  const url = tab && tab.url;
  if (!url || !/^https?:/.test(url)) {
    await update((s) => ({ state: engine.rollover(s, now) }));
    badge("");
    return;
  }
  // A video playing counts as being there, even with hands off the keyboard.
  const active = (await chrome.idle.queryState(IDLE_SECONDS)) === "active" || !!tab.audible;
  const out = await update((s) => engine.tick(s, { url, title: tab.title || "", focused, active, seconds, now }));
  if (out.sort) sortSite(out.sort, tab.title || "");
  const d = out.decision;
  if (d.verdict !== "allow") {
    await chrome.tabs.update(tab.id, { url: gateUrl(url) });
    badge("");
  } else {
    badge(d.watched ? String(d.leftMinutes) : "");
  }
}

/** Ask the relay which kind an unknown site is, and remember the answer on this device. */
async function sortSite(domain, title) {
  const s = await load();
  const r = await callRelay("/sort", { installId: s.installId, domain, title: title.slice(0, 300) });
  const kind = r.ok && typeof r.data.kind === "string" ? r.data.kind : null;
  await update((st) => ({ state: kind ? engine.recordSort(st, domain, kind) : engine.sortFailed(st, domain, Date.now()) }));
}

function badge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#3b5bdb" });
}

// ---------- the pages ----------

const handlers = {
  async hello() {
    return { protocol: PROTOCOL };
  },
  async state() {
    const s = engine.rollover(await load(), Date.now());
    return { state: s, now: Date.now(), closed: engine.closedKinds(s, Date.now()) };
  },
  async decide({ url }) {
    await update((s) => ({ state: engine.rollover(s, Date.now()) }));
    const decision = engine.decide(state, { url, now: Date.now() });
    const cooldownUntil = (state.cooldowns || {})[decision.kind] || 0;
    return { decision, goal: state.goal, talk: state.talk, cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : 0 };
  },
  // One message at the gate. The relay is asked only if the engine says there is something to ask.
  async talk({ url, message, lastTurn }) {
    const req = engine.gateRequest(await load(), { url, message, now: Date.now() });
    if (req.refused) return { decision: "refused", reason: req.refused, until: req.until };
    const r = await callRelay("/gate", req.payload);
    if (!r.ok) return { decision: "error", error: r.error, scope: r.scope };
    const out = await update((s) => engine.applyGateAnswer(s, { kind: req.payload.kind, answer: r.data, lastTurn: !!lastTurn, now: Date.now() }));
    return out.result;
  },
  // The pages ask for the all-sites permission themselves, inside the click; this records the answer.
  async consent({ talk, sorting }) {
    if (sorting && !(await chrome.permissions.contains(ALL_SITES))) sorting = false;
    await update((s) => {
      let n = s;
      if (talk !== undefined) n = engine.setTalk(n, talk);
      if (sorting !== undefined) n = engine.setSorting(n, sorting);
      return { state: n };
    });
    return { talk: state.talk, sorting: state.sorting };
  },
  async setup({ kinds, goal }) {
    const out = await update((s) => engine.completeSetup(s, { kinds, goal }, Date.now()));
    return { now: out.now, later: out.later, from: out.from };
  },
  async propose({ rules, goal }) {
    const out = await update((s) => {
      const r = engine.proposeRules(s, rules, Date.now());
      return { ...r, state: goal === undefined ? r.state : engine.setGoal(r.state, goal) };
    });
    return { now: out.now, later: out.later, from: out.from };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !handlers[msg && msg.type]) return;
  handlers[msg.type](msg).then(reply, (e) => reply({ error: String(e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("pages/welcome.html") });
});

chrome.action.onClicked.addListener(async () => {
  const s = await load();
  chrome.tabs.create({ url: chrome.runtime.getURL(s.setupDone ? "pages/rules.html" : "pages/welcome.html") });
});

// Sorting needs to see every site; if the permission is taken away, sorting stops.
chrome.permissions.onRemoved.addListener(async () => {
  if (!(await chrome.permissions.contains(ALL_SITES))) update((s) => ({ state: engine.setSorting(s, false) }));
});

chrome.tabs.onActivated.addListener(tick);
chrome.windows.onFocusChanged.addListener(tick);
// The alarm wakes the worker if the browser ever stops it; the interval is the real clock, and its
// browser calls every two seconds keep the worker alive.
chrome.alarms.create("tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(tick);
setInterval(tick, TICK_MS);
update((s) => ({ state: engine.rollover(s, Date.now()) }));
