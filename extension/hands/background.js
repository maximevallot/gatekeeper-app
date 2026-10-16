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
let blocking = null; // the enforcement last written into the browser's rules
let closedBefore = ""; // the closed domains at the last sweep of open tabs
let blind = []; // watched domains the browser does not let Gatekeeper see
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

/** The watched domains whose access the user withheld (site access "On click", or one site removed). */
async function withheldDomains() {
  const { origins = [] } = await chrome.permissions.getAll();
  const all = origins.some((o) => o === "<all_urls>" || o === "*://*/*");
  const granted = new Set(origins.map((o) => (o.match(/^\*:\/\/\*\.([^/]+)\/\*$/) || [])[1]).filter(Boolean));
  const covered = (d) => { for (let x = d; x.includes("."); x = x.slice(x.indexOf(".") + 1)) if (granted.has(x)) return true; return false; };
  return all ? [] : engine.watchedDomains(state).filter((d) => !covered(d));
}

async function syncBlocking() {
  const e = engine.enforcement(state, Date.now(), { withheld: await withheldDomains() });
  blind = e.blind;
  const key = JSON.stringify([e.redirect, e.block]);
  if (key !== blocking) {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: buildRules(e, GATE) });
    blocking = key;
  }
  // When a kind closes, every open tab of it goes to the gate, not only the one in front.
  const closedNow = e.redirect.join(" ");
  if (closedNow !== closedBefore) {
    closedBefore = closedNow;
    if (e.redirect.length) await sweepTabs();
  }
}

async function sweepTabs() {
  const now = Date.now();
  for (const tab of await chrome.tabs.query({})) {
    if (tab.url && /^https?:/.test(tab.url) && engine.decide(state, { url: tab.url, now }).verdict !== "allow") {
      chrome.tabs.update(tab.id, { url: gateUrl(tab.url) }).catch(() => {});
    }
  }
}

function gateUrl(url) {
  return GATE + "#" + url;
}

async function frontTab() {
  try {
    // App windows ("Install YouTube") and popups count as much as normal ones.
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal", "popup", "app"] });
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
  const front = tab && tab.url && /^https?:/.test(tab.url) ? tab.url : null;
  // Pages playing sound in any window count too: a video in a background window or picture-in-picture.
  const audible = (await chrome.tabs.query({ audible: true }))
    .filter((t) => t.url && /^https?:/.test(t.url) && !(tab && t.id === tab.id)).map((t) => t.url);
  // A video playing counts as being there, even with hands off the keyboard.
  const active = (await chrome.idle.queryState(IDLE_SECONDS)) === "active" || !!(tab && tab.audible);
  const out = await update((s) => engine.tick(s, { url: front || "", title: (tab && tab.title) || "", focused, active, seconds, now, audible }));
  if (!front) {
    badge(blind.length ? "!" : "");
    return;
  }
  const url = front;
  if (out.sort) sortSite(out.sort, tab.title || "");
  const d = out.decision;
  if (d.verdict !== "allow") {
    await chrome.tabs.update(tab.id, { url: gateUrl(url) });
    badge(blind.length ? "!" : "");
  } else {
    badge(blind.length ? "!" : d.watched ? String(d.leftMinutes) : "");
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
  chrome.action.setBadgeBackgroundColor({ color: text === "!" ? "#c2410c" : "#3b5bdb" });
}

// ---------- the pages ----------

const handlers = {
  async hello() {
    return { protocol: PROTOCOL };
  },
  async state() {
    const s = engine.rollover(await load(), Date.now());
    const incognito = await chrome.extension.isAllowedIncognitoAccess();
    return { state: s, now: Date.now(), closed: engine.closedKinds(s, Date.now()), blind, incognito };
  },
  async decide({ url }) {
    await update((s) => ({ state: engine.rollover(s, Date.now()) }));
    const decision = engine.decide(state, { url, now: Date.now() });
    const cooldownUntil = (state.cooldowns || {})[decision.kind] || 0;
    const incognito = await chrome.extension.isAllowedIncognitoAccess();
    return { decision, goal: state.goal, talk: state.talk, cooldownUntil: cooldownUntil > state.clock.floor ? cooldownUntil : 0, incognito, blind };
  },
  // One message at the gate. The relay is asked only if the engine says there is something to ask.
  async talk({ url, message }) {
    const req = engine.gateRequest(await load(), { url, message, now: Date.now() });
    if (req.refused) return { decision: "refused", reason: req.refused, until: req.until };
    const r = await callRelay("/gate", req.payload);
    if (!r.ok) return { decision: "error", error: r.error, scope: r.scope };
    const out = await update((s) => engine.applyGateAnswer(s, { url, answer: r.data, now: Date.now() }));
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
// Access taken away from one watched site is caught by syncBlocking on the next tick.
chrome.permissions.onRemoved.addListener(async () => {
  if (!(await chrome.permissions.contains(ALL_SITES))) update((s) => ({ state: engine.setSorting(s, false) }));
  else update((s) => ({ state: s }));
});
chrome.permissions.onAdded.addListener(() => update((s) => ({ state: s })));

chrome.tabs.onActivated.addListener(tick);
chrome.windows.onFocusChanged.addListener(tick);
// The alarm wakes the worker if the browser ever stops it; the interval is the real clock, and its
// browser calls every two seconds keep the worker alive.
chrome.alarms.create("tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(tick);
setInterval(tick, TICK_MS);
update((s) => ({ state: engine.rollover(s, Date.now()) }));
