// The hands, in the browser. They report the page in front and enforce what the engine decides; they
// decide nothing. The state lives in chrome.storage.local, and only this worker writes it, one change
// at a time. The only network calls go to the relay (hands/relay.js), and only after the user said yes.

import * as engine from "../engine/engine.js";
import { videoUrl, videoKeyOf } from "../engine/videos.js";
import { buildRules } from "./blocker.js";
import { callRelay, relayTime, callAccount } from "./relay.js";
import * as account from "../engine/account.js";
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
    // The hands guard the clock: a jump is checked against the relay's time before it counts (QA round 2, C1).
    state = engine.guardClock(engine.upgrade((await chrome.storage.local.get("state")).state));
    await loadAccount();
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

// ---------- the clock ----------

let lastTimeCheck = 0;
/** The clock jumped: ask the relay for the time, at most twice a minute, until it answers. */
async function checkTime() {
  if (!state || !engine.timeCheckNeeded(state) || Date.now() - lastTimeCheck < 30e3) return;
  lastTimeCheck = Date.now();
  const t = await relayTime();
  if (t) await update((s) => ({ state: engine.confirmTime(s, t) }));
}

// ---------- the account (one Gatekeeper per person, contract version 1) ----------
// The account on the relay holds the one true state. This browser keeps a copy, decides every page from it, and
// syncs about every 30 seconds and right after anything the user does: spans of time and requests go up, a fresh
// copy comes down. Its token and the outbox live in storage of their own, never inside the state that is sent.

const SYNC_MS = 30e3;
const MAX_SPANS = 20000; // about a day of ticks, if offline that long
let acct = null; // { accountId, deviceId, token, version, lastSync, error, created }
let outbox = { seq: 0, sentUpTo: 0, spans: [], requests: [] };
let reqN = 0;

async function loadAccount() {
  const r = await chrome.storage.local.get(["account", "outbox"]);
  acct = r.account || null;
  outbox = r.outbox || { seq: 0, sentUpTo: 0, spans: [], requests: [] };
}
const saveAccount = () => chrome.storage.local.set({ account: acct, outbox });

/** "Brave on Mac": shown in the account's device list. */
function deviceName() {
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
  const ua = navigator.userAgent;
  const browser = brands.find((b) => /Brave|Edge|Opera|Vivaldi/.test(b)) || (/Safari/.test(ua) && !/Chrom/.test(ua) ? "Safari" : brands.includes("Google Chrome") ? "Chrome" : "Chrome");
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "this computer";
  return `${browser.replace("Microsoft ", "")} on ${os}`.slice(0, 60);
}
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const engineNow = () => Math.max((state && state.clock && state.clock.floor) || 0, (state && state.usage && state.usage.spanEnd) || 0, 0) || Date.now();

/** A tick's span, kept until the account has counted it; a span touching the last unsent one with the same buckets extends it. */
function keepSpan(span) {
  if (!acct || !span) return;
  const last = outbox.spans[outbox.spans.length - 1];
  const same = last && last.seq > outbox.sentUpTo && last.to === span.from && JSON.stringify(last.buckets) === JSON.stringify(span.buckets);
  if (same) last.to = span.to;
  else outbox.spans.push({ seq: ++outbox.seq, from: span.from, to: span.to, buckets: span.buckets });
  if (outbox.spans.length > MAX_SPANS) outbox.spans = outbox.spans.slice(-MAX_SPANS);
}

/** A request the user made here: applied to the copy already, and sent at the next sync (soon). */
function sendLater(req) {
  if (!acct || !acct.token) return;
  outbox.requests.push({ id: `r-${Date.now()}-${++reqN}`, ...req });
  saveAccount();
  syncSoon();
}
let soon = null;
function syncSoon() { clearTimeout(soon); soon = setTimeout(() => sync(), 300); }

let syncing = null;
/**
 * One sync: spans and requests up, the copy down. `now` is this request alone, for what needs Claude (sent at
 * once, and not kept if the account can't be reached). Returns the results by request id, or null if unreachable.
 */
function sync(now = []) {
  const run = (syncing || Promise.resolve()).then(() => syncOnce(now));
  syncing = run.catch(() => null);
  return run;
}
async function syncOnce(now) {
  if (!acct || !acct.token) return null;
  await load();
  const spans = outbox.spans.slice(), requests = [...outbox.requests, ...now];
  outbox.sentUpTo = outbox.seq;
  const r = await callAccount("sync", { now: engineNow(), tz: tz(), have: acct.version || 0, spans, requests }, acct.token);
  if (!r.ok) {
    if (r.error === "bad_token") acct = { ...acct, token: null, error: "removed" }; // removed from the account: carry on alone
    else if (r.error === "account_deleted") acct = { ...acct, token: null, error: "deleted" };
    else acct = { ...acct, error: r.error || "unreachable" };
    await saveAccount();
    return null;
  }
  const d = r.data;
  const answered = new Set(requests.map((q) => q.id));
  outbox.requests = outbox.requests.filter((q) => !answered.has(q.id));
  outbox.spans = outbox.spans.filter((x) => x.seq > (d.spansUpTo ?? 0));
  acct = { ...acct, version: d.version ?? acct.version, lastSync: Date.now(), error: null, serverNow: d.serverNow };
  if (d.copy) {
    // The account's copy, with this device's own fields, and what it did since this sync began applied again.
    await update((st) => ({ state: engine.guardClock(account.rebase(st, d.copy, { spans: outbox.spans, ops: outbox.requests.filter((q) => account.LOCAL_OPS.includes(q.type)) })) }));
  }
  await saveAccount();
  const results = new Map();
  (d.results || []).forEach((x, i) => results.set((x && x.id) || (requests[i] && requests[i].id), x));
  return results;
}

/** A request that needs Claude: asked of the account at once. Null when it can't be reached. */
async function askAccount(req) {
  const q = { id: `r-${Date.now()}-${++reqN}`, ...req };
  const results = await sync([q]);
  return results ? results.get(q.id) || { error: "no_result" } : null;
}

/** The welcome is finished (or an install from before accounts starts up): make the account, with this state. */
async function createAccount() {
  if (acct && (acct.token || acct.error === "left")) return acct;
  const s = await load();
  const r = await callAccount("create", { device: { name: deviceName(), kind: "extension" }, tz: tz(), now: engineNow(), state: s });
  if (!r.ok) { acct = { ...(acct || {}), error: r.error || "unreachable", pendingCreate: true }; await saveAccount(); return null; }
  const d = r.data;
  acct = { accountId: d.accountId, deviceId: d.device.id, token: d.device.token, version: d.version, lastSync: Date.now(), error: null, created: Date.now() };
  outbox = { seq: 0, sentUpTo: 0, spans: [], requests: [] };
  if (d.copy) await update((st) => ({ state: engine.guardClock(account.rebase(st, d.copy)) }));
  await saveAccount();
  return acct;
}

/** Join the account another device shows a code for. This device's own account, if any, is left first. */
async function joinAccount(code) {
  const s = await load();
  if (acct && acct.token) await callAccount("leave", {}, acct.token);
  const r = await callAccount("join", { code: String(code || "").replace(/\D/g, "").slice(0, 6), device: { name: deviceName(), kind: "extension" }, tz: tz(), now: engineNow(), state: s.setupDone ? s : undefined });
  if (!r.ok) return { error: r.error || "unreachable" };
  const d = r.data;
  acct = { accountId: d.accountId, deviceId: d.device.id, token: d.device.token, version: d.version, lastSync: Date.now(), error: null, joined: Date.now() };
  outbox = { seq: 0, sentUpTo: 0, spans: [], requests: [] };
  await update((st) => ({ state: engine.guardClock(account.rebase(st, d.copy)) }));
  await saveAccount();
  return { ok: true, merged: d.merged || null };
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
    // The account gets the next 48 hours' events (titles and times), never the link.
    const soonEvents = (state.calendar.events || []).filter((e) => e.start <= Date.now() + 48 * 3600e3).slice(0, 20);
    sendLater({ type: "calendar", events: soonEvents });
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
  const snap = engine.snapshot(state, Date.now(), { extensionId: chrome.runtime.id, base: chrome.runtime.getURL("") });
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
  // Gatekeeper for Mac 0.2.0 (contract v1): it follows one browser, says which snapshot versions it reads, and
  // names what it couldn't read.
  const mac = (reply && reply.mac) || null;
  const outdated = !!(mac && Array.isArray(mac.reads) && !mac.reads.includes(snap.v));
  macStatus = {
    connected: !!(reply && reply.ok) && !outdated,
    error: outdated ? "mac_outdated" : reply && reply.ok ? null : (reply && reply.error) || "bad_reply",
    linkedName: reply && reply.error === "other_browser_linked" ? String(reply.linkedName || reply.linked || "another browser").slice(0, 60) : null,
    reason: reply && reply.reason ? String(reply.reason).slice(0, 120) : null,
    version: mac && typeof mac.version === "string" ? mac.version.slice(0, 20) : null,
  };
  const requests = reply && reply.ok && Array.isArray(reply.requests) ? reply.requests.slice(0, 10) : [];
  if (requests.length) {
    await update((s) => {
      let n = s;
      for (const r of requests) {
        n = engine.applyMacRequest(n, r, Date.now()).state;
        if (r && r.type === "exam.start") sendLater({ type: "startExam", until: r.until, goal: r.goal, source: "mac" });
      }
      return { state: n };
    });
    macSync(true); // the result shows in the next snapshot
  }
}

async function syncBlocking() {
  const e = engine.enforcement(state, Date.now(), { withheld: await withheldDomains(), seeAll: await chrome.permissions.contains(ALL_SITES) });
  blind = e.blind;
  const key = JSON.stringify([e.redirect, e.block, e.allowVideos, e.closeVideos, e.allowSites, e.examAll]);
  if (key !== blocking) {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: buildRules(e, GATE) });
    blocking = key;
  }
  // When a kind closes, every open tab of it goes to the gate, not only the one in front.
  const closedNow = e.redirect.join(" ") + (e.examAll ? " *" : "");
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
  // Safari has no chrome.idle: there, a focused window counts as the user being there (tick also needs focus).
  const present = chrome.idle ? (await chrome.idle.queryState(IDLE_SECONDS)) === "active" : true;
  const active = present || !!(tab && tab.audible);
  const out = await update((s) => engine.tick(s, { url: front || "", title: (tab && tab.title) || "", focused, active, seconds, now, audible }));
  keepSpan(out.span);
  checkTime();
  // Each period of withheld site access goes into the history (QA round 2 #3, "Make it visible").
  if (JSON.stringify((state.withheld && state.withheld.domains) || []) !== JSON.stringify([...blind].sort())) {
    await update((st) => ({ state: engine.noteWithheld(st, blind, Date.now()) }));
  }
  if (!front) {
    badge(blind.length ? "!" : "");
    return;
  }
  const url = front;
  if (out.sort) sortSite(out.sort, tab.title || "");
  // The watch week just ended: show the week once, with the way to set limits from it.
  if (engine.watchReady(state) && !watchTabOpened) {
    watchTabOpened = true;
    // Once ever: marked shown as it opens, so a browser restart doesn't open it again.
    await update((st) => ({ state: engine.markWatchShown(st) }));
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/week.html?ready=1") });
  }
  if (out.judge) judgeVideo(out.judge);
  const d = out.decision;
  if (d.verdict !== "allow") {
    await chrome.tabs.update(tab.id, { url: gateUrl(url) });
    badge(blind.length ? "!" : "");
  } else {
    // The watch week shows the minutes so far (QA round 2, first-run H1); otherwise the minutes left.
    badge(blind.length ? "!" : d.watching ? String(d.usedMinutes || 0) : d.watched && Number.isFinite(d.leftMinutes) ? String(d.leftMinutes) : "");
  }
}

const sortingNow = new Set();
/** Ask the relay which kind an unknown site is, and remember the answer on this device. */
async function sortSite(domain, title) {
  const s = await load();
  const r = await callRelay("/sort", { installId: s.installId, domain, title: title.slice(0, 300) });
  const kind = r.ok && typeof r.data.kind === "string" ? r.data.kind : null;
  await update((st) => ({ state: kind ? engine.recordSort(st, domain, kind) : engine.sortFailed(st, domain, Date.now()) }));
  if (kind) sendLater({ type: "sorted", domain, kind });
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
    sendLater({ type: "judged", key, rule, by });
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
    const seeAll = await chrome.permissions.contains(ALL_SITES);
    return { state: s, now: Date.now(), closed: engine.closedKinds(s, Date.now()), blind, incognito, seeAll, consent: engine.consentStatus(s) };
  },
  async decide({ url, count }) {
    // `count`: the gate page's first look at a closed site, one more "time the gate held" for the week.
    await update((s) => {
      const r = engine.rollover(s, Date.now());
      const held = count && engine.decide(r, { url, now: Date.now() }).verdict !== "allow";
      if (held) sendLater({ type: "noteGate" });
      return { state: held ? engine.noteGate(r, Date.now()) : r };
    });
    // A video stopped before it loaded, not judged yet: judge it now; the gate asks again in a moment.
    const judging = engine.needsJudgment(state, url);
    if (judging) judgeVideo(videoKeyOf(url));
    const decision = engine.decide(state, { url, now: Date.now() });
    // Exam mode closes a site not sorted yet: sort it now (with Claude help); a study site then opens.
    const domain = engine.siteDomain(url);
    const sorting = !!(decision.unsorted && engine.consented(state, "sorting") && state.sorting && domain);
    if (sorting && !sortingNow.has(domain)) { sortingNow.add(domain); sortSite(domain, "").finally(() => sortingNow.delete(domain)); }
    const cooldownUntil = (state.cooldowns || {})[decision.ladder || decision.kind] || 0;
    const incognito = await chrome.extension.isAllowedIncognitoAccess();
    return { decision, goal: state.goal, talk: engine.consented(state, "talk"), cooldownUntil: cooldownUntil > state.clock.floor ? cooldownUntil : 0, incognito, blind, judging, sorting };
  },
  // One message at the gate. The relay is asked only if the engine says there is something to ask.
  async talk({ url, message }) {
    const req = engine.gateRequest(await load(), { url, message, now: Date.now() });
    if (req.refused) return { decision: "refused", reason: req.refused, until: req.until };
    if (acct && acct.token) {
      // The account asks Claude itself, with its own state; only the page's scheme and host are sent.
      let origin = url;
      try { origin = new URL(url).origin + "/"; } catch {}
      const r = await askAccount({ type: "talk", url: origin, message });
      return r || { decision: "error", error: "unreachable" };
    }
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
    if (help !== undefined) sendLater({ type: "consent", help, seeAll });
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
    if (acct && acct.token) {
      // The account adds the turn, asks Claude and keeps the card; the copy brings them back here.
      const r = await askAccount({ type: "chat", message });
      if (r) return r;
      await update((s) => ({ state: engine.addTurn(engine.addTurn(s, "user", message, Date.now()), "gatekeeper", "Can't reach your Gatekeeper account right now. Your rules page still works.", Date.now()) }));
      return { failed: "unreachable" };
    }
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
    sendLater({ type: "applyCard" });
    macSync(true);
    return out.refused ? { refused: out.refused } : out.outcome;
  },
  async dropCard() {
    await update((s) => ({ state: engine.dropCard(s, Date.now()) }));
    sendLater({ type: "dropCard" });
    return { ok: true };
  },
  async forgetThread() {
    await update((s) => ({ state: engine.forgetThread(s) }));
    sendLater({ type: "forgetThread" });
    return { ok: true };
  },
  // The watch week: start it from the welcome tab, end it early with one tap, and mark its summary seen.
  // Start exam mode, or move its end later: a tightening, at once.
  async startExam({ until, goal, source }) {
    const from = ["today", "rules", "calendar"].includes(source) ? source : "extension";
    const out = await update((s) => engine.startExam(s, { until, goal, source: from }, Date.now()));
    if (!out.refused) sendLater({ type: "startExam", until, goal, source: from });
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
    sendLater({ type: "dismissOffer", offer });
    return { ok: true };
  },
  // Ending exam mode early: a request to the agent, or a reason why nothing is asked (decision 3).
  async endExam() {
    const out = await update((s) => engine.endExam(s, Date.now()));
    if (out.needsOk) sendLater({ type: "endExam" });
    macSync(true);
    return { refused: out.refused, until: out.until, needsOk: !!out.needsOk };
  },
  // The reason for a loosening, to the agent who holds the key. Out of reach: the morning rule, as before.
  async loosen({ message }) {
    const req = engine.loosenRequest(await load(), { message, now: Date.now() });
    if (req.refused) return { decision: "refused", reason: req.refused };
    if (acct && acct.token) {
      // The account holds the key: it asks the agent with its own state, and its answer comes back in the copy.
      const r = await askAccount({ type: "loosen", message });
      if (r) return r;
      await update((s) => engine.loosenUnavailable(s, { message, error: "unreachable", now: Date.now() }));
      return { decision: "unavailable", error: "unreachable" };
    }
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
  // "Drop this change" next to a loosening's reason box: the change is cancelled, nothing loosens.
  async dropLoosen() {
    await update((s) => ({ state: engine.dropLoosen(s, Date.now()) }));
    sendLater({ type: "dropLoosen" });
    return { ok: true };
  },
  // ---------- the account: Settings › Your Gatekeeper, and the welcome's "Already use Gatekeeper?" ----------
  async accountStatus() {
    await load();
    const view = acct ? { accountId: acct.accountId, deviceId: acct.deviceId, in: !!acct.token, lastSync: acct.lastSync || 0, problem: acct.error || null, created: acct.created || 0 } : null;
    let devices = null;
    if (acct && acct.token) {
      const r = await callAccount("devices", {}, acct.token);
      if (r.ok) devices = r.data.devices;
    }
    return { account: view, devices, name: deviceName(), pending: outbox.requests.length, unsent: outbox.spans.length };
  },
  async addDevice() {
    if (!(acct && acct.token)) return { error: "no_account" };
    const r = await callAccount("code", {}, acct.token);
    return r.ok ? { code: r.data.code, expiresAt: r.data.expiresAt } : { error: r.error };
  },
  async joinAccount({ code }) {
    return joinAccount(code);
  },
  async removeDevice({ deviceId }) {
    if (!(acct && acct.token)) return { error: "no_account" };
    const r = await callAccount("remove", { deviceId }, acct.token);
    return r.ok ? { ok: true } : { error: r.error };
  },
  // Leaving loosens nothing: the copy stays, and this browser carries on alone.
  async leaveAccount() {
    if (!(acct && acct.token)) return { error: "no_account" };
    const r = await callAccount("leave", {}, acct.token);
    if (!r.ok && r.status !== 401 && r.status !== 410) return { error: r.error };
    if (r.ok && r.data.copy) await update((st) => ({ state: engine.guardClock(account.leaveCopy(r.data.copy, st)) }));
    acct = { ...acct, token: null, error: "left" };
    outbox = { seq: 0, sentUpTo: 0, spans: [], requests: [] };
    await saveAccount();
    return { ok: true };
  },
  async deleteAccount() {
    if (!(acct && acct.token)) return { error: "no_account" };
    const r = await callAccount("delete", {}, acct.token);
    if (!r.ok) return { error: r.error };
    acct = { ...acct, token: null, error: "deleted" };
    await saveAccount();
    return { ok: true };
  },
  async exportAccount() {
    if (!(acct && acct.token)) return { error: "no_account" };
    const r = await callAccount("export", {}, acct.token);
    return r.ok ? { data: r.data } : { error: r.error };
  },
  async syncNow() {
    const r = await sync();
    return { ok: !!r };
  },
  async mac() {
    await macSync(true);
    // As macError: a reply with "error" would read to the page's ask() as the worker failing.
    const { error, ...rest } = macStatus;
    return { ...rest, macError: error, permitted: await chrome.permissions.contains(NATIVE) };
  },
  async watch({ goal }) {
    await update((s) => ({ state: engine.startWatch(s, { goal }, Date.now()) }));
    // Finishing the welcome makes the account (said plainly on the welcome page).
    if (!(acct && acct.token)) await createAccount(); else sendLater({ type: "watch", goal });
    return { ok: true };
  },
  async endWatch() {
    await update((s) => ({ state: engine.endWatch(s, Date.now()) }));
    sendLater({ type: "endWatch" });
    return { ok: true };
  },
  async watchShown() {
    await update((s) => ({ state: engine.markWatchShown(s) }));
    sendLater({ type: "watchShown" });
    return { ok: true };
  },
  async setup({ kinds, goal }) {
    const out = await update((s) => engine.completeSetup(s, { kinds, goal }, Date.now()));
    // Finishing the welcome makes the account (said plainly on the welcome page); a device that joined sends it.
    if (!(acct && acct.token)) await createAccount(); else sendLater({ type: "setup", kinds, goal });
    return { now: out.now, later: out.later, from: out.from };
  },
  async propose({ rules, goal }) {
    const out = await update((s) => {
      const r = engine.proposeRules(s, rules, Date.now(), { undoable: true });
      return { ...r, state: goal === undefined ? r.state : engine.setGoal(r.state, goal) };
    });
    sendLater({ type: "propose", rules, goal, undoable: true });
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
chrome.alarms.create("sync", { periodInMinutes: 0.5 }); // the account, about every 30 seconds
chrome.alarms.onAlarm.addListener((a) => (a.name === "mac" ? macSync(true) : a.name === "calendar" ? readCalendar() : a.name === "sync" ? accountTick() : tick()));
setInterval(accountTick, SYNC_MS);

/** Every 30 seconds: sync, or make the account a set-up install from before accounts doesn't have yet. */
async function accountTick() {
  await load();
  if (acct && acct.token) return sync();
  if (state.setupDone && (!acct || acct.pendingCreate)) return createAccount();
}
setInterval(tick, TICK_MS);
update((s) => ({ state: engine.rollover(s, Date.now()) }));
