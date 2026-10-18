// The hands, in the browser. They report the page in front and enforce what the engine decides; they
// decide nothing. The state lives in chrome.storage.local, and only this worker writes it, one change
// at a time. The only network calls go to the relay (hands/relay.js), and only after the user said yes.

import * as engine from "../engine/engine.js";
import { videoUrl, videoKeyOf } from "../engine/videos.js";
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
let watchTabOpened = false; // the end-of-watch-week tab, opened once per worker
let macSent = null; // the last snapshot sent to Gatekeeper for Mac, as snapshotKey
let macStatus = { connected: false, error: null }; // how the last exchange went
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
    macSync();
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

// ---------- the calendar link ----------

/** Read the pasted calendar link, at most once a day (or now, `force`). Nothing from it is sent anywhere. */
async function readCalendar(force = false) {
  const s = await load();
  if (!s.calendar || (!force && !engine.calendarDue(s, Date.now()))) return;
  try {
    const res = await fetch(s.calendar.url, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error("http_" + res.status);
    const text = (await res.text()).slice(0, 2_000_000);
    await update((st) => ({ state: engine.recordCalendar(st, text, Date.now()) }));
  } catch (e) {
    await update((st) => ({ state: engine.calendarFailed(st, (e && e.message) || "unreachable", Date.now()) }));
  }
}

// ---------- Gatekeeper for Mac (native messaging, contract version 1) ----------

const MAC_HOST = "com.gatekeeper.helper";
const NATIVE = { permissions: ["nativeMessaging"] };

/** Send today to the Mac app when what it shows changed, or always with `force` (the minute's heartbeat). */
let macBusy = false, macAgain = false, macForce = false;
async function macSync(force = false) {
  // One exchange at a time; a change during one is sent right after it.
  if (macBusy) { macAgain = true; macForce = macForce || force; return; }
  macBusy = true;
  try { await macExchange(force); } finally {
    macBusy = false;
    if (macAgain) { const f = macForce; macAgain = macForce = false; macSync(f); }
  }
}

async function macExchange(force) {
  if (!state || !(await chrome.permissions.contains(NATIVE))) return;
  if (typeof chrome.runtime.sendNativeMessage !== "function") {
    // Granted, but this worker started before the grant and has no binding for it yet.
    macStatus = { connected: false, error: "reload_needed" };
    return;
  }
  const snap = engine.snapshot(state, Date.now(), { extensionId: chrome.runtime.id });
  const key = engine.snapshotKey(snap);
  if (!force && key === macSent) return;
  macSent = key;
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(MAC_HOST, snap);
  } catch (e) {
    // No Mac app installed, or it failed: the extension works on its own, and tries again next time.
    macStatus = { connected: false, error: String((e && e.message) || e).slice(0, 200) };
    macSent = null;
    return;
  }
  macStatus = { connected: !!(reply && reply.ok), error: reply && reply.ok ? null : (reply && reply.error) || "bad_reply" };
  const requests = reply && reply.ok && Array.isArray(reply.requests) ? reply.requests.slice(0, 10) : [];
  if (requests.length) {
    await update((s) => {
      let n = s;
      for (const r of requests) n = engine.applyMacRequest(n, r, Date.now()).state;
      return { state: n };
    });
    macSync(true); // the result shows in the next snapshot
  }
}

async function syncBlocking() {
  const e = engine.enforcement(state, Date.now(), { withheld: await withheldDomains() });
  blind = e.blind;
  const key = JSON.stringify([e.redirect, e.block, e.allowVideos, e.closeVideos]);
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
  // The watch week just ended: show the week once, with the way to set limits from it.
  if (engine.watchReady(state) && !watchTabOpened) {
    watchTabOpened = true;
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/week.html?ready=1") });
  }
  if (out.judge) judgeVideo(out.judge);
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

/**
 * Which video rule a video falls under. YouTube's public oEmbed address gives its title and channel (a host
 * Gatekeeper already holds); then the relay asks Claude if the user said yes, else the rules' words decide
 * on this device. A video whose title cannot be had falls under no rule and counts against Video.
 */
const judgingNow = new Set();
async function judgeVideo(key) {
  if (judgingNow.has(key)) return;
  judgingNow.add(key);
  try {
    let title = "", channel = "";
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(videoUrl(key)), { credentials: "omit", signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) ({ title = "", author_name: channel = "" } = await res.json());
    } catch {}
    const req = engine.judgeRequest(await load(), key, { title, channel });
    let rule = req.local ?? null, by = "words";
    if (req.payload) {
      const r = await callRelay("/judge", req.payload);
      if (r.ok && r.data.judged === true) {
        rule = r.data.rule;
        by = "claude";
      } else {
        rule = req.fallback; // the relay could not judge: the words decide
      }
    }
    await update((s) => ({ state: engine.recordJudgment(s, key, rule, by, Date.now()) }));
    tick(); // a video that is now closed goes to the gate at once
  } finally {
    judgingNow.delete(key);
  }
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
    return { state: s, now: Date.now(), closed: engine.closedKinds(s, Date.now()), blind, incognito, consent: engine.consentStatus(s) };
  },
  async decide({ url, count }) {
    // `count`: the gate page's first look at a closed site, one more "time the gate held" for the week.
    await update((s) => {
      const r = engine.rollover(s, Date.now());
      return { state: count && engine.decide(r, { url, now: Date.now() }).verdict !== "allow" ? engine.noteGate(r, Date.now()) : r };
    });
    // A video stopped before it loaded, not judged yet: judge it now; the gate asks again in a moment.
    const judging = engine.needsJudgment(state, url);
    if (judging) judgeVideo(videoKeyOf(url));
    const decision = engine.decide(state, { url, now: Date.now() });
    const cooldownUntil = (state.cooldowns || {})[decision.kind] || 0;
    const incognito = await chrome.extension.isAllowedIncognitoAccess();
    return { decision, goal: state.goal, talk: engine.consented(state, "talk"), cooldownUntil: cooldownUntil > state.clock.floor ? cooldownUntil : 0, incognito, blind, judging };
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
  async consent({ talk, sorting, chat, judge, help }) {
    if (sorting && !(await chrome.permissions.contains(ALL_SITES))) sorting = false;
    const seeAll = await chrome.permissions.contains(ALL_SITES);
    await update((s) => {
      let n = s;
      // The one "Claude help" switch; sorting comes with it only where the browser lets Gatekeeper see every site.
      if (help !== undefined) n = engine.setHelp(n, help, { sorting: seeAll });
      if (talk !== undefined) n = engine.setTalk(n, talk);
      if (sorting !== undefined) n = engine.setSorting(n, sorting);
      if (chat !== undefined) n = engine.setConsent(n, "chat", chat);
      if (judge !== undefined) n = engine.setConsent(n, "judge", judge);
      return { state: n };
    });
    return {
      talk: engine.consented(state, "talk"), sorting: engine.consented(state, "sorting") && state.sorting,
      chat: engine.consented(state, "chat"), judge: engine.consented(state, "judge"),
      help: engine.consented(state, "help"),
    };
  },
  // One message in the one thread. Nothing changes here: an answer that changes rules comes back as a card.
  async chat({ message }) {
    const req = engine.chatRequest(await load(), { message, now: Date.now() });
    if (req.refused) return { refused: req.refused };
    await update((s) => ({ state: engine.addTurn(s, "user", message, Date.now()) }));
    const r = await callRelay("/rules", req.payload);
    const preview = r.ok ? engine.chatPreview(await load(), r.data, Date.now()) : null;
    if (!r.ok || preview.error) {
      const failed = r.ok ? preview.error : r.error || "unreachable";
      await update((s) => ({ state: engine.addTurn(s, "gatekeeper", failed === "daily_limit" ? "That's enough changes by talking for today." : "Can't reach Claude right now. Your rules page still works.", Date.now()) }));
      return { failed };
    }
    await update((s) => ({ state: engine.recordChatAnswer(s, r.data, preview, Date.now()) }));
    return { ok: true };
  },
  // Apply the open card, checked again against the rules as they are now.
  async applyCard() {
    const out = await update((s) => engine.applyCard(s, Date.now()));
    macSync(true);
    return out.refused ? { refused: out.refused } : out.outcome;
  },
  async dropCard() {
    await update((s) => ({ state: engine.dropCard(s, Date.now()) }));
    return { ok: true };
  },
  async forgetThread() {
    await update((s) => ({ state: engine.forgetThread(s) }));
    return { ok: true };
  },
  // The watch week: start it from the welcome tab, end it early with one tap, and mark its summary seen.
  // Start exam mode, or move its end later: a tightening, at once.
  async startExam({ until, goal, source }) {
    const from = ["today", "rules", "calendar"].includes(source) ? source : "extension";
    const out = await update((s) => engine.startExam(s, { until, goal, source: from }, Date.now()));
    macSync(true);
    return { ok: !out.refused, refused: out.refused, exam: out.exam };
  },
  // The calendar link: kept on this device and read here once a day; the page asked the browser for the site.
  async setCalendar({ url }) {
    const out = await update((s) => engine.setCalendar(s, url));
    if (out.refused) return { refused: out.refused };
    if (out.url) await readCalendar(true);
    const c = state.calendar;
    return { ok: true, events: c ? c.events.length : 0, error: c && c.error };
  },
  async dismissOffer({ offer }) {
    await update((s) => ({ state: engine.dismissOffer(s, offer) }));
    return { ok: true };
  },
  // Ending exam mode early: a request to the agent, or a reason why nothing is asked (decision 3).
  async endExam() {
    const out = await update((s) => engine.endExam(s, Date.now()));
    macSync(true);
    return { refused: out.refused, until: out.until, needsOk: !!out.needsOk };
  },
  // The reason for a loosening, to the agent who holds the key. Out of reach: the morning rule, as before.
  async loosen({ message }) {
    const req = engine.loosenRequest(await load(), { message, now: Date.now() });
    if (req.refused) return { decision: "refused", reason: req.refused };
    const r = await callRelay("/loosen", req.payload);
    if (!r.ok) {
      await update((s) => engine.loosenUnavailable(s, { message, error: r.error, now: Date.now() }));
      return { decision: "unavailable", error: r.error };
    }
    const out = await update((s) => engine.applyLoosenAnswer(s, { answer: r.data, message, now: Date.now() }));
    if (out.result.decision === "error") {
      await update((s) => engine.loosenUnavailable(s, { message, error: "bad_answer", now: Date.now() }));
      return { decision: "unavailable", error: "bad_answer" };
    }
    return out.result;
  },
  async mac() {
    await macSync(true);
    return { ...macStatus, permitted: await chrome.permissions.contains(NATIVE) };
  },
  async watch({ goal }) {
    await update((s) => ({ state: engine.startWatch(s, { goal }, Date.now()) }));
    return { ok: true };
  },
  async endWatch() {
    await update((s) => ({ state: engine.endWatch(s, Date.now()) }));
    return { ok: true };
  },
  async watchShown() {
    await update((s) => ({ state: engine.markWatchShown(s) }));
    return { ok: true };
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
    return { now: out.now, later: out.later, from: out.from, needsOk: !!out.needsOk, refused: out.refused };
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

// The toolbar button opens pages/popup.html, Today (manifest action.default_popup).

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
chrome.alarms.create("mac", { periodInMinutes: 1 }); // the Mac app's heartbeat, and its requests
chrome.alarms.create("calendar", { periodInMinutes: 60 }); // the calendar link, read once a day
chrome.alarms.onAlarm.addListener((a) => (a.name === "mac" ? macSync(true) : a.name === "calendar" ? readCalendar() : tick()));
setInterval(tick, TICK_MS);
update((s) => ({ state: engine.rollover(s, Date.now()) }));
