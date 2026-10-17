// The engine: rules, budgets, today's usage, and the decision for a page. Every function takes the
// state and returns a new one; nothing here touches a browser, the clock or storage, so the same code
// can later run on a server for every device. The hands (the extension today, a Mac helper and an
// iPhone app later) only report what is in front and enforce what the engine says.
//
// Rules are kinds of sites plus budgets: { kinds: { games: { minutes: 15 } }, sites: { "x.io": "games" } }.
// A kind absent from `kinds` is not watched. 0 minutes means always closed.
// Tightening a rule applies at once; loosening it waits until the next morning (dayStart, local time).
// Moving a site to a kind with more time left is a loosening too.
//
// Time only goes forward. The engine keeps the latest time it has seen (clock.floor) and reads every
// `now` through it, so setting the clock back changes nothing. The day ends at an absolute moment fixed
// when it began (usage.endsAt), so a timezone change does not start a new one. A pass is a number of
// seconds that ticks use up, not an hour on the clock.
//
// Milestone 2 adds the gate that talks back and the sorting of unknown sites. The engine builds what is
// sent and applies what comes back (a pass, a cooldown, a site's kind); the hands make the network call.
// Nothing is sent unless the user said yes: `talk` for the gate, `sorting` for unknown sites.
//
// Milestone 3 adds video rules (rules about kinds of YouTube videos, each with its own budget; see
// videos.js) and the rules chat. Each yes to sending something is kept with the version of the text the
// user agreed to (CONSENT); when what is sent changes, the version goes up and the user is asked again.

import { KINDS, hostOf, matches } from "./catalog.js";
import {
  MAX_JUDGED, videoKeyOf, videoSiteOf, videoRulesKey, videoName, cleanVideos, tightenVideos,
  describeVideoChanges, matchWords, applyDiff, rulesForChat,
} from "./videos.js";

export const DEFAULT_MINUTES = 15;
export const DEFAULT_DAY_START = 4; // the day, and every budget, turns over at 4:00
export const MAX_TICK_SECONDS = 5; // one report never counts more than this, so a sleeping laptop costs nothing
export const SORT_AFTER_SECONDS = 60; // an unknown site is sorted once it has been in front this long
export const SORT_RETRY_MS = 3600e3; // after a failed sort, wait an hour before asking again
export const PASS_LADDER = [10, 5, 2]; // the longest first, second and third pass for a kind in one day; then none
export const MAX_PASS_MINUTES = PASS_LADDER[0]; // the relay clamps a pass to this too
export const COOLDOWN_MS = 10 * 60e3; // after a no, the gate does not listen again for this long
export const AFTER_PASS_MS = 15 * 60e3; // after a pass ends, the gate does not listen again for this long
export const FOLLOW_UP_MS = 10 * 60e3; // one follow-up to a question, within this long
export const MAX_MESSAGE = 500;
export const JUDGE_RETRY_MS = 60e3; // a judgment in flight is asked again after this long
export const MAX_ALLOWED_VIDEOS = 50; // judged videos given a rule of their own in the browser, per list (five filters each)

// The version of each consent text. Raise one when what that switch sends changes: the user is asked again.
// talk: the gate. sorting: unknown sites. chat: the rules chat. judge: video rules judged by Claude.
export const CONSENT = { talk: 1, sorting: 1, chat: 1, judge: 1, help: 2 };

// "Claude help": one yes for everything below. Raise CONSENT.help whenever this list changes, so the user is
// asked again. The pages show this list, word for word, before the first request.
export const HELP_COVERS = ["talk", "chat", "judge", "sorting"];
export const WHATS_SENT = [
  { what: "The gate", sent: "the site's name (not its address) and kind, today's minutes and budget for that kind, your goal sentence, and what you type", when: "when you ask the gate for time" },
  { what: "Changing rules by talking", sent: "what you type, the earlier messages of that talk, your rules (no usage), and today's date", when: "when you send a message" },
  { what: "Asking to loosen a rule", sent: "the change in words, your goal sentence, and your reason as you type it", when: "when you loosen a rule or end exam mode early" },
  { what: "Video rules", sent: "a YouTube video's title and channel, and the wording of your video rules", when: "once per video you open, when you have video rules" },
  { what: "Sorting new sites", sent: "the site's name and page title", when: "once per site Gatekeeper doesn't know, after a minute on it" },
];
export const SENT_TO = "Each request also carries a random install number. It goes to Gatekeeper's relay, which asks Anthropic's Claude and keeps none of it. Nothing else leaves this browser: never page content, addresses, or other tabs.";

export function initialState() {
  return {
    version: 2,
    setupDone: false,
    goal: "",
    rules: { kinds: {}, sites: {}, videos: [], dayStart: DEFAULT_DAY_START },
    pending: null, // { rules, from }: a looser version waiting for the morning
    clock: { floor: 0 }, // the latest time seen; time never goes back
    usage: { day: null, endsAt: 0, seconds: {}, passes: {} }, // passes: kind -> passes granted today
    installId: null, // a random UUID the hands make on first run; the relay counts its daily cap by it
    talk: false, // the user said yes to sending a gate message to the relay
    sorting: false, // the user said yes to sorting sites the catalog does not know
    sorted: {}, // domain -> kind, as the relay sorted it
    unknown: {}, // domain -> { seconds, asking, retryAt }: unknown sites in front today
    passes: {}, // domain -> { kind, secondsLeft }: a pass the gate granted for one site
    cooldowns: {}, // kind -> until (ms): the gate does not listen
    followUps: {}, // kind -> until (ms): the gate asked a question; one answer is allowed
    consent: {}, // switch -> the CONSENT version the user said yes to
    judged: {}, // "yt:<id>" -> { rule, key, by, at }: which video rule a video falls under (rule null: none)
    judging: {}, // "yt:<id>" -> when it was asked: a judgment in flight
    history: [], // one summary per finished day, the last HISTORY_DAYS, on this device only
  };
}

/** A state saved by an older version, with every field this one expects. Today's usage is kept. */
export function upgrade(state) {
  if (!state) return initialState();
  const s = { ...initialState(), ...state };
  if ((state.version || 1) < 2) {
    const u = state.usage || {};
    const endsAt = u.day ? dayEnd(u.day, (s.rules && s.rules.dayStart) ?? DEFAULT_DAY_START) : 0;
    s.usage = { day: u.day || null, endsAt, seconds: u.seconds || {}, passes: {} };
    s.passes = {}; // version 1 passes were per kind and clock-based; they last minutes, so they are dropped
    s.version = 2;
  }
  if (!Array.isArray(s.rules.videos)) s.rules = { ...s.rules, videos: [] };
  // The switches before consent had versions: a yes then was a yes to version 1 of the text.
  const consent = { ...(s.consent || {}) };
  if (s.talk && !consent.talk) consent.talk = 1;
  if (s.sorting && !consent.sorting) consent.sorting = 1;
  s.consent = consent;
  return s;
}

// ---------- time ----------

export function dayKey(now, dayStart = DEFAULT_DAY_START) {
  const d = new Date(now - dayStart * 3600e3);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
}

export function nextDayStart(now, dayStart = DEFAULT_DAY_START) {
  const d = new Date(now);
  d.setHours(dayStart, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function dayEnd(key, dayStart) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d + 1, dayStart).getTime();
}

const clamp = (seconds) => Math.max(0, Math.min(Number(seconds) || 0, MAX_TICK_SECONDS));

// ---------- sorting sites ----------

function longestMatch(host, table) {
  let best = null;
  for (const [domain, kind] of Object.entries(table || {})) {
    if (matches(host, domain) && (!best || domain.length > best.domain.length)) best = { domain, kind };
  }
  return best;
}

function catalogMatch(host) {
  let best = null;
  for (const [kind, k] of Object.entries(KINDS)) {
    for (const d of k.domains) if (matches(host, d) && (!best || d.length > best.domain.length)) best = { domain: d, kind };
  }
  return best;
}

/** Which entry a host falls under: the user's own sites first, then the catalog, then what the relay sorted. */
function entryFor(state, host) {
  if (!host) return null;
  return longestMatch(host, state.rules.sites) || catalogMatch(host) || longestMatch(host, state.sorted);
}

export function kindOf(state, url) {
  const e = entryFor(state, hostOf(url));
  return e ? e.kind : null;
}

/** The name a site is sorted under: the host without "www.". */
export function siteDomain(url) {
  const host = hostOf(url);
  return host ? host.replace(/^www\./, "") : null;
}

export function label(kind) {
  return (KINDS[kind] && KINDS[kind].label) || kind;
}

// ---------- the day ----------

/** Read the clock through the floor, end the day if its moment has come, and apply what waited for it. */
export function rollover(state, now) {
  let s = state;
  const t = Math.max(Number(now) || 0, (s.clock && s.clock.floor) || 0);
  if (!s.clock || s.clock.floor !== t) s = { ...s, clock: { floor: t } };
  const ending = !s.usage.endsAt || t >= s.usage.endsAt;
  // The day that ends goes into the week's history, under the rules it was lived by.
  if (ending && s.usage.day) s = { ...s, history: [...(s.history || []).filter((h) => h.day !== s.usage.day), daySummary(s)].slice(-HISTORY_DAYS) };
  // A loosening applies in the morning only once the agent said yes, or when no agent could be asked.
  if (s.pending && t >= s.pending.from && s.pending.ok !== false) s = { ...s, rules: s.pending.rules, pending: null };
  if (ending) {
    s = {
      ...s,
      usage: { day: dayKey(t, s.rules.dayStart), endsAt: nextDayStart(t, s.rules.dayStart), seconds: {}, passes: {}, gates: 0 },
      unknown: {}, followUps: {},
    };
  }
  return s;
}

// ---------- the week ----------
// Kept on this device only: one line per day, the minutes on watched sites, the minutes allowed, how many
// times a gate closed a site, and how many passes the gate granted.

export const HISTORY_DAYS = 30;

function daySummary(s) {
  const seconds = Object.values(s.usage.seconds || {}).reduce((a, b) => a + b, 0);
  const allowed = Object.values(s.rules.kinds || {}).reduce((a, k) => a + (k.minutes || 0), 0);
  const passes = Object.values(s.usage.passes || {}).reduce((a, b) => a + b, 0);
  const kinds = {};
  for (const k of Object.keys(KINDS)) if (s.usage.seconds[k]) kinds[k] = Math.round(s.usage.seconds[k] / 60);
  // A watch day is one that lay inside the watch week, judged by its own dates, not by when it was closed.
  const w = s.watch;
  const inWatch = !!w && s.usage.endsAt > w.from && s.usage.endsAt <= w.until;
  return { day: s.usage.day, minutes: Math.round(seconds / 60), allowed, gates: s.usage.gates || 0, passes, kinds, watching: inWatch || undefined };
}

// ---------- the watch week ----------
// A new install can begin with a week of only counting: every kind is counted, nothing is blocked. The
// week it records is the "as is" baseline the user then sets rules against. One tap skips it.

export const WATCH_DAYS = 7;

/** Whether the watch week is on now. */
export function watching(state) {
  const w = state.watch;
  return !!w && !w.ended && (state.clock ? state.clock.floor : 0) < w.until;
}

/** Begin the watch week: seven whole days, ending at the morning hour after the seventh. */
export function startWatch(state, { goal } = {}, now) {
  const s = rollover(state, now);
  const t = s.clock.floor;
  const until = nextDayStart(t + (WATCH_DAYS - 1) * 86400e3, s.rules.dayStart);
  return { ...setGoal(s, goal === undefined ? s.goal : goal), setupDone: true, watch: { from: t, until } };
}

/** End the watch week now (the user skipped the rest, or set rules). */
export function endWatch(state, now) {
  const s = rollover(state, now);
  return s.watch ? { ...s, watch: { ...s.watch, until: Math.min(s.watch.until, s.clock.floor), ended: true } } : s;
}

/** The watch week has ended and its summary has not been shown yet. */
export function watchReady(state) {
  return !!state.watch && !watching(state) && !state.watch.shown;
}

export function markWatchShown(state) {
  return state.watch ? { ...state, watch: { ...state.watch, shown: true } } : state;
}

/** Minutes a day per kind over the recorded days, and a starting limit for each: half, in steps of 5. */
export function baseline(state, now) {
  const s = rollover(state, now);
  const days = (s.history || []).filter((h) => !s.watch || (h.day >= dayKey(s.watch.from, s.rules.dayStart)));
  const n = Math.max(1, days.length);
  const out = [];
  for (const k of Object.keys(KINDS)) {
    const total = days.reduce((a, d) => a + ((d.kinds || {})[k] || 0), 0);
    if (!total) continue;
    const perDay = Math.round(total / n);
    out.push({ kind: k, label: label(k), perDay, suggested: Math.max(5, Math.round(perDay / 2 / 5) * 5) });
  }
  return { days: days.length, kinds: out.sort((a, b) => b.perDay - a.perDay) };
}

/** A gate was shown for a closed site: one more for the week's count. */
export function noteGate(state, now) {
  const s = rollover(state, now);
  return { ...s, usage: { ...s.usage, gates: (s.usage.gates || 0) + 1 } };
}

/** The last seven days, today last; a day with no record (before history began) is null. */
export function weekSummary(state, now) {
  const s = rollover(state, now);
  const t = s.clock.floor;
  const byDay = new Map((s.history || []).map((h) => [h.day, h]));
  byDay.set(s.usage.day, daySummary(s));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(t - i * 86400e3, s.rules.dayStart);
    const [y, m, d] = key.split("-").map(Number);
    days.push({ day: key, weekday: new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short" }), ...(byDay.get(key) || { none: true }) });
  }
  const kept = days.filter((d) => !d.none);
  const sum = (f) => kept.reduce((a, d) => a + (d[f] || 0), 0);
  return {
    days, minutes: sum("minutes"), allowed: sum("allowed"), gates: sum("gates"), passes: sum("passes"),
    clearDays: kept.filter((d) => d.day !== s.usage.day && !d.gates).length, keptDays: kept.length,
    loosenAsked: (s.loosenLog || []).filter((e) => e.at > t - 7 * 86400e3 && e.decision !== "ask").length,
    loosenAllowed: (s.loosenLog || []).filter((e) => e.at > t - 7 * 86400e3 && e.decision === "allow").length,
  };
}

// ---------- today ----------

const SHORT = { social: "Social" };

/** What the toolbar's Today shows: one entry per watched kind, the goal, and the day's end. */
export function todaySummary(state, now) {
  const s = rollover(state, now);
  const order = [...Object.keys(KINDS)].filter((k) => s.rules.kinds[k]);
  const kinds = order.map((k) => {
    const minutes = s.rules.kinds[k].minutes;
    const used = usedSeconds(s, k);
    const left = Math.max(0, Math.ceil((minutes * 60 - used) / 60));
    const status = minutes === 0 ? "closed" : used >= minutes * 60 ? "spent" : "open";
    return { kind: k, label: label(k), short: SHORT[k] || label(k), minutes, left, status, fraction: minutes ? Math.max(0, (minutes * 60 - used) / (minutes * 60)) : 0 };
  });
  const watch = watching(s) ? {
    day: Math.min(WATCH_DAYS, Math.floor((s.clock.floor - s.watch.from) / 86400e3) + 1), of: WATCH_DAYS, until: s.watch.until,
    kinds: Object.keys(KINDS).map((k) => ({ kind: k, label: label(k), short: SHORT[k] || label(k), used: Math.floor(usedSeconds(s, k) / 60) })),
  } : null;
  const exam = examOn(s) ? { ...s.rules.exam } : null;
  if (exam) for (const k of kinds) { k.status = "closed"; k.exam = true; }
  return { kinds, goal: s.goal || "", reopensAt: s.usage.endsAt, setupDone: !!s.setupDone, waiting: !!s.pending, watch, watchReady: watchReady(s), exam };
}

const usedSeconds = (s, kind) => s.usage.seconds[kind] || 0;

function passFor(s, url, kind) {
  const e = entryFor(s, hostOf(url));
  const p = e && (s.passes || {})[e.domain];
  return p && p.kind === kind && p.secondsLeft > 0 ? p : null;
}

// ---------- the decision ----------

/**
 * What to do with a page. verdict: "allow" (not watched, time left, or a pass for this site),
 * "gate" (today's budget is spent), "block" (0 minutes).
 */
export function decide(state, { url, title = "", now }) {
  const s = rollover(state, now);
  if (examOn(s)) {
    // Exam mode closes every kind, watched or not, until it ends; a video rule that makes videos free still holds.
    const video = videoDecision(s, url, title);
    if (video && video.verdict === "allow" && !video.watched) return video;
    const kind = kindOf(s, url);
    if (KINDS[kind]) {
      return { verdict: "block", kind, bucket: kind, label: label(kind), watched: true, title, exam: { ...s.rules.exam },
        usedMinutes: Math.floor(usedSeconds(s, kind) / 60), budgetMinutes: (s.rules.kinds[kind] || {}).minutes ?? null, reopensAt: s.rules.exam.until };
    }
    return { verdict: "allow", kind, watched: false };
  }
  if (watching(s)) {
    // The watch week counts every kind and blocks nothing.
    const kind = kindOf(s, url);
    return KINDS[kind] ? { verdict: "allow", kind, bucket: kind, label: label(kind), watched: true, watching: true } : { verdict: "allow", kind, watched: false };
  }
  const video = videoDecision(s, url, title);
  if (video) return video;
  const kind = kindOf(s, url);
  const rule = kind && s.rules.kinds[kind];
  if (!rule) return { verdict: "allow", kind, watched: false };
  const budget = rule.minutes * 60;
  const used = usedSeconds(s, kind);
  const base = {
    kind, bucket: kind, label: label(kind), watched: true, title,
    usedMinutes: Math.floor(used / 60), budgetMinutes: rule.minutes,
    leftMinutes: Math.max(0, Math.ceil((budget - used) / 60)),
    reopensAt: s.usage.endsAt,
  };
  const pass = passFor(s, url, kind);
  if (pass) return { ...base, verdict: "allow", pass: true, leftMinutes: Math.ceil(pass.secondsLeft / 60) };
  if (rule.minutes === 0) return { ...base, verdict: "block" };
  if (used >= budget) return { ...base, verdict: "gate" };
  return { ...base, verdict: "allow" };
}

/**
 * The hands report every few seconds: the page in front, whether its window is focused and the user is
 * there, and the pages playing sound in any window. Each watched kind on screen or playing counts once.
 * Every tick uses up the passes, whatever is in front.
 */
export function tick(state, { url, title = "", focused, active, seconds, now, audible = [] }) {
  let s = rollover(state, now);
  const t = s.clock.floor;
  const add = clamp(seconds);
  if (add && Object.keys(s.passes || {}).length) {
    const passes = {};
    for (const [d, p] of Object.entries(s.passes)) if (p.secondsLeft - add > 0) passes[d] = { ...p, secondsLeft: p.secondsLeft - add };
    s = { ...s, passes };
  }
  const counted = new Set();
  const front = decide(s, { url, title, now: t });
  if (focused && active && front.watched && front.verdict === "allow") counted.add(front.bucket);
  for (const u of audible) {
    const d = decide(s, { url: u, now: t });
    if (d.watched && d.verdict === "allow") counted.add(d.bucket);
  }
  if (add && counted.size) {
    const sec = { ...s.usage.seconds };
    for (const k of counted) sec[k] = (sec[k] || 0) + add;
    s = { ...s, usage: { ...s.usage, seconds: sec } };
  }
  // A site nobody has sorted: once it has been in front for a minute, ask the relay once.
  let sort = null;
  const domain = siteDomain(url);
  if (front.kind === null && s.sorting && focused && active && domain) {
    const e = (s.unknown || {})[domain] || { seconds: 0 };
    const next = { ...e, seconds: e.seconds + add };
    const asking = e.asking && t - e.asking < 120e3; // a call in flight; a lost one is retried after 2 minutes
    if (next.seconds >= SORT_AFTER_SECONDS && !asking && !(e.retryAt > t)) {
      next.asking = t;
      sort = domain;
    }
    s = { ...s, unknown: { ...(s.unknown || {}), [domain]: next } };
  }
  // A video on a site with video rules, not judged under their present wording: ask once.
  let judge = null;
  const key = videoKeyOf(url);
  if (key && focused && needsJudgment(s, url)) {
    const asked = (s.judging || {})[key];
    if (!(asked && t - asked < JUDGE_RETRY_MS)) {
      const judging = {};
      for (const [k, at] of Object.entries(s.judging || {})) if (t - at < 10 * JUDGE_RETRY_MS) judging[k] = at;
      s = { ...s, judging: { ...judging, [key]: t } };
      judge = key;
    }
  }
  return { state: s, decision: decide(s, { url, title, now: t }), sort, judge };
}

// ---------- video rules ----------

const videoRules = (s, site) => (s.rules.videos || []).filter((v) => v.site === site);

/** The rule a judged video falls under, or null: not a video, no rules, not judged yet, or no rule fits. */
function videoRuleFor(s, url) {
  const key = videoKeyOf(url), site = videoSiteOf(url);
  if (!key || !site) return null;
  const rules = videoRules(s, site);
  const j = rules.length && (s.judged || {})[key];
  if (!j || j.key !== videoRulesKey(rules, site) || !j.rule) return null;
  return rules.find((v) => v.id === j.rule) || null;
}

function videoDecision(s, url, title) {
  const v = videoRuleFor(s, url);
  if (!v) return null;
  const kind = kindOf(s, url);
  const base = { kind, video: { id: v.id, name: videoName(v), except: v.except }, label: `Videos about ${videoName(v)}`, title };
  if (v.minutes === null) return { ...base, verdict: "allow", watched: false };
  const bucket = "v:" + v.id;
  const used = usedSeconds(s, bucket);
  const d = {
    ...base, bucket, watched: true,
    usedMinutes: Math.floor(used / 60), budgetMinutes: v.minutes,
    leftMinutes: Math.max(0, Math.ceil((v.minutes * 60 - used) / 60)), reopensAt: s.usage.endsAt,
  };
  if (v.minutes === 0) return { ...d, verdict: "block" };
  return { ...d, verdict: used >= v.minutes * 60 ? "gate" : "allow" };
}

/** Whether this page is a video that a video rule may apply to and that has no judgment yet. */
export function needsJudgment(state, url) {
  const key = videoKeyOf(url), site = videoSiteOf(url);
  if (!key || !site) return false;
  const rules = videoRules(state, site);
  if (!rules.length) return false;
  const j = (state.judged || {})[key];
  return !j || j.key !== videoRulesKey(rules, site);
}

/**
 * How to judge one video, given its title and channel (from YouTube). With the user's yes to judging by
 * Claude, the payload for the relay's /judge: the site, the title, the channel and each rule's wording.
 * Without it, the answer from the rules' word lists on this device, and nothing is sent.
 */
export function judgeRequest(state, key, { title = "", channel = "" }) {
  const site = "youtube.com";
  const rules = videoRules(state, site);
  const t = String(title).replace(/\s+/g, " ").trim().slice(0, 200);
  const c = String(channel).replace(/\s+/g, " ").trim().slice(0, 100);
  if (!rules.length) return { local: null };
  if (!consented(state, "judge") || !t) return { local: matchWords(rules, { title: t, channel: c }) };
  return {
    payload: { installId: state.installId, site, title: t, channel: c, rules: rules.map(({ id, about, except }) => ({ id, about, except })) },
    fallback: matchWords(rules, { title: t, channel: c }),
  };
}

/** Keep which rule a video falls under (null: none), under the rules' present wording. */
export function recordJudgment(state, key, rule, by, now) {
  const t = Math.max(Number(now) || 0, (state.clock && state.clock.floor) || 0);
  const rules = videoRules(state, "youtube.com");
  const ok = rule === null || rules.some((v) => v.id === rule);
  const { [key]: _, ...judging } = state.judging || {};
  const judged = { ...(state.judged || {}), [key]: { rule: ok ? rule : null, key: videoRulesKey(rules, "youtube.com"), by, at: t } };
  const keep = Object.entries(judged).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_JUDGED);
  return { ...state, judged: Object.fromEntries(keep), judging };
}

/** The relay's answer for a domain. From now on it counts against that kind, if the kind is watched. */
export function recordSort(state, domain, kind) {
  const { [domain]: _, ...unknown } = state.unknown || {};
  return { ...state, sorted: { ...(state.sorted || {}), [domain]: kind }, unknown };
}

export function sortFailed(state, domain, now) {
  const t = Math.max(now, (state.clock && state.clock.floor) || 0);
  const e = (state.unknown || {})[domain] || { seconds: 0 };
  return { ...state, unknown: { ...(state.unknown || {}), [domain]: { ...e, asking: null, retryAt: t + SORT_RETRY_MS } } };
}

// ---------- what the hands enforce ----------

/** Kinds closed right now: 0 minutes, or today's budget spent. */
export function closedKinds(state, now) {
  const s = rollover(state, now);
  if (examOn(s)) return Object.keys(KINDS);
  if (watching(s)) return [];
  return Object.keys(s.rules.kinds).filter((k) => s.rules.kinds[k].minutes === 0 || usedSeconds(s, k) >= s.rules.kinds[k].minutes * 60);
}

/** Every domain that counts against a watched kind: the catalog's, the user's own and the sorted ones. */
export function watchedDomains(state) {
  const exam = examOn(state);
  const watched = (k) => !!KINDS[k] && (exam || !!state.rules.kinds[k]);
  const out = [];
  for (const [k, def] of Object.entries(KINDS)) if (watched(k)) out.push(...def.domains);
  for (const [d, k] of Object.entries(state.rules.sites || {})) if (watched(k)) out.push(d);
  for (const [d, k] of Object.entries(state.sorted || {})) if (watched(k)) out.push(d);
  // A site the user moved to an unwatched kind is not caught by its catalog entry.
  return [...new Set(out)].filter((d) => watched(kindOf(state, "https://" + d + "/")));
}

export function closedDomains(state, now) {
  const s = rollover(state, now);
  const closed = new Set(closedKinds(s, now));
  return watchedDomains(s).filter((d) => {
    const kind = kindOf(s, "https://" + d + "/");
    const p = (s.passes || {})[d];
    return closed.has(kind) && !(p && p.kind === kind && p.secondsLeft > 0);
  });
}

/**
 * What the hands write into the browser. `redirect`: closed sites, sent to the gate before they load
 * (needs the extension's access to the site). `block`: closed sites again, for embedded frames and for a
 * site whose access was withheld, where a redirect cannot fire; plus every watched site whose access was
 * withheld, since time there cannot be counted. `withheld` lists the domains the browser does not let
 * the extension see.
 */
export function enforcement(state, now, { withheld = [] } = {}) {
  const s = rollover(state, now);
  const closed = closedDomains(s, now);
  const hidden = new Set(withheld);
  const passed = (d) => { const p = (s.passes || {})[d]; return p && p.secondsLeft > 0; };
  const blind = watchedDomains(s).filter((d) => hidden.has(d) && !passed(d));
  // Judged videos: one a rule lets through stays reachable when its site is closed; one a rule closes is
  // stopped before it loads. Videos opened inside YouTube are caught by the tick instead. With YouTube's
  // access withheld the tick cannot see the page, so a video whose rule counts time is not let through:
  // its minutes could not be counted. A free video can be, since nothing is counted there.
  const youtubeBlind = blind.some((d) => d === "youtube.com" || d === "youtu.be");
  const allowVideos = [], closeVideos = [];
  const recent = Object.entries(s.judged || {}).sort((a, b) => b[1].at - a[1].at);
  for (const [key, j] of recent) {
    if (!j.rule) continue;
    const d = decide(s, { url: "https://www.youtube.com/watch?v=" + key.slice(3), now });
    if (!d.video) continue;
    if (d.verdict === "allow") { if (!(youtubeBlind && d.watched)) allowVideos.push(key); }
    else closeVideos.push(key);
  }
  return {
    redirect: closed, block: [...new Set([...closed, ...blind])], blind,
    allowVideos: allowVideos.slice(0, MAX_ALLOWED_VIDEOS), closeVideos: closeVideos.slice(0, MAX_ALLOWED_VIDEOS),
  };
}

// ---------- changing the rules ----------

/** Rules as the user may set them: known kinds, whole minutes from 0 to 1440, sites as domains. */
export function cleanRules(rules, fallback) {
  const r = rules || {};
  const kinds = {};
  for (const [k, v] of Object.entries(r.kinds || {})) if (KINDS[k] && v) kinds[k] = { minutes: clampMinutes(v.minutes) };
  const sites = {};
  for (const [d, k] of Object.entries(r.sites || {})) {
    const host = hostOf("https://" + String(d) + "/");
    if (host && host.includes(".") && KINDS[k]) sites[host.replace(/^www\./, "")] = k;
  }
  const ds = Number(r.dayStart);
  const dayStart = Number.isInteger(ds) && ds >= 0 && ds <= 23 ? ds : fallback.dayStart;
  const e = r.exam;
  const exam = e && Number.isFinite(Number(e.until)) ? { until: Number(e.until), goal: String(e.goal || "").replace(/\s+/g, " ").trim().slice(0, 200) } : null;
  return { kinds, sites, videos: cleanVideos(r.videos), dayStart, exam };
}

/**
 * The stricter of the rules in force (cur) and the rules asked for (next), rule by rule. A site moving
 * between kinds applies now only if its new kind leaves no more time today and no more time a day than its
 * old one; otherwise it waits. `state` gives today's usage.
 */
export function tighten(cur, next, state) {
  const kinds = {};
  for (const k of new Set([...Object.keys(cur.kinds), ...Object.keys(next.kinds)])) {
    const a = cur.kinds[k], b = next.kinds[k];
    kinds[k] = a && b ? { ...b, minutes: Math.min(a.minutes, b.minutes) } : a || b; // a kind dropped waits
  }
  const withKinds = { ...state, rules: { ...cur, kinds } };
  const left = (k) => { const r = k && kinds[k]; return !r ? Infinity : r.minutes === 0 ? 0 : Math.max(0, r.minutes * 60 - usedSeconds(withKinds, k)); };
  const perDay = (k) => { const r = k && kinds[k]; return r ? r.minutes : Infinity; };
  const kindUnder = (rules, d) => kindOf({ ...state, rules: { ...rules, kinds } }, "https://" + d + "/");
  const sites = {};
  for (const d of new Set([...Object.keys(cur.sites || {}), ...Object.keys(next.sites || {})])) {
    const a = kindUnder(cur, d), b = kindUnder(next, d);
    const stricter = a === b || (left(b) <= left(a) && perDay(b) <= perDay(a));
    const pick = stricter ? next.sites : cur.sites;
    if (pick && d in pick) sites[d] = pick[d];
  }
  const youtube = kindUnder(cur, "youtube.com"); // the kind YouTube's own pages count against today
  const videos = tightenVideos(cur.videos || [], next.videos || [], { watched: !!(youtube && kinds[youtube]) });
  // Exam mode in force can only be extended now; ending or shortening it waits (the sentence ends it at once).
  const t = (state.clock && state.clock.floor) || 0;
  const a = cur.exam && cur.exam.until > t ? cur.exam : null, b = next.exam || null;
  const exam = a ? (b && b.until >= a.until ? b : a) : b;
  return { ...next, kinds, sites, videos, dayStart: cur.dayStart, exam };
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Each difference between two rule sets, in words a person reads. */
export function describeChanges(cur, next) {
  const out = [];
  for (const k of new Set([...Object.keys(cur.kinds), ...Object.keys(next.kinds)])) {
    const a = cur.kinds[k], b = next.kinds[k];
    if (a && !b) out.push({ kind: k, text: `${label(k)}: no longer watched` });
    else if (!a && b) out.push({ kind: k, text: `${label(k)}: ${minutesText(b.minutes)}` });
    else if (a.minutes !== b.minutes) out.push({ kind: k, text: `${label(k)}: ${minutesText(a.minutes)} → ${minutesText(b.minutes)}` });
  }
  const sites = new Set([...Object.keys(cur.sites || {}), ...Object.keys(next.sites || {})]);
  for (const d of sites) {
    const a = (cur.sites || {})[d], b = (next.sites || {})[d];
    if (a && !b) out.push({ site: d, text: `${d}: no longer counted as ${label(a).toLowerCase()}` });
    else if (!a && b) out.push({ site: d, text: `${d}: counted as ${label(b).toLowerCase()}` });
    else if (a !== b) out.push({ site: d, text: `${d}: ${label(a).toLowerCase()} → ${label(b).toLowerCase()}` });
  }
  out.push(...describeVideoChanges(cur.videos || [], next.videos || []));
  if (cur.dayStart !== next.dayStart) out.push({ text: `The day starts at ${next.dayStart}:00` });
  const ea = cur.exam || null, eb = next.exam || null;
  if ((ea && ea.until) !== (eb && eb.until)) {
    const until = (x) => new Date(x.until).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
    out.push({ text: eb ? `Exam mode until ${until(eb)}` : "Exam mode ends" });
  }
  return out;
}

export function minutesText(m) {
  return m === 0 ? "closed all day" : `${m} min a day`;
}

/**
 * Ask for new rules. What tightens applies now; what loosens waits until the next morning.
 * Asking again replaces what was waiting, so asking for the rules in force cancels it.
 * Returns { state, now: [changes applied], later: [changes waiting], from }.
 */
export function proposeRules(state, next, now) {
  const s = rollover(state, now);
  const want = cleanRules({ dayStart: s.rules.dayStart, ...next }, s.rules);
  const applied = tighten(s.rules, want, s);
  const nowChanges = describeChanges(s.rules, applied);
  const keepExamAsk = s.loosen && s.loosen.kind === "exam" ? s.loosen : null;
  if (same(applied, want)) {
    return { state: { ...s, rules: want, pending: null, loosen: keepExamAsk }, now: nowChanges, later: [], from: null };
  }
  const from = s.usage.endsAt;
  const later = describeChanges(applied, want);
  const key = loosenKey(later);
  const t = s.clock.floor;
  if (((s.denied || {})[key] || 0) > t) {
    // The agent said no to this today: the same request waits until tomorrow, and the rules stay.
    return { state: { ...s, rules: applied, pending: null, loosen: keepExamAsk }, now: nowChanges, later: [], from: null, refused: "asked_today", denied: later };
  }
  // With Claude help on, the agent holds the key: the loosening waits for its yes, then for the morning.
  // Without it, or if it cannot be reached, a loosening waits for the morning only, as before.
  const agent = consented(s, "talk");
  const already = s.pending && s.pending.key === key && s.pending.ok;
  const pending = { rules: want, from, key, ok: already || !agent };
  const loosen = pending.ok ? keepExamAsk : { kind: "rules", changes: later.map((c) => c.text), key, asked: "" };
  return {
    state: { ...s, rules: applied, pending, loosen },
    now: nowChanges, later, from, needsOk: !pending.ok,
  };
}

const loosenKey = (changes) => JSON.stringify(changes.map((c) => c.text || c).sort());

/** The welcome tab's answers. The first rules only add limits, so they all apply at once. */
export function completeSetup(state, { kinds, goal }, now) {
  if (watching(rollover(state, now))) state = endWatch(state, now); // setting rules ends the watch week
  const rules = { ...state.rules, kinds: {} };
  for (const [k, m] of Object.entries(kinds)) rules.kinds[k] = { minutes: clampMinutes(m) };
  const r = proposeRules(state, rules, now);
  return { ...r, state: { ...r.state, goal: String(goal || "").trim().slice(0, 300), setupDone: true } };
}

export function setGoal(state, goal) {
  return { ...state, goal: String(goal || "").replace(/\s+/g, " ").trim().slice(0, 300) };
}

export function clampMinutes(m) {
  const n = Math.round(Number(m));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 24 * 60) : DEFAULT_MINUTES;
}

// ---------- the gate that talks back ----------

/**
 * What the gate sends to the relay for one message, or why it sends nothing. Only what the relay's
 * /gate needs: the site's domain, its kind, today's minutes and budget, the goal, and the message.
 */
export function gateRequest(state, { url, message, now }) {
  const s = rollover(state, now);
  const t = s.clock.floor;
  const d = decide(s, { url, now: t });
  const text = String(message || "").trim();
  if (!consented(s, "talk")) return { refused: "no_consent" };
  if (d.verdict === "allow") return { refused: "open" };
  if (d.exam) return { refused: "exam" }; // exam mode has no second round
  if (d.video) return { refused: "video_rule" }; // a video rule is changed on the rules page, not argued at the gate
  const cool = (s.cooldowns || {})[d.kind] || 0;
  if (cool > t) return { refused: "cooldown", until: cool };
  if ((s.usage.passes[d.kind] || 0) >= PASS_LADDER.length) return { refused: "passes_used" };
  if (!text) return { refused: "empty" };
  return {
    payload: {
      installId: s.installId, goal: s.goal || "", site: siteDomain(url), kind: d.kind,
      minutesUsed: Math.min(d.usedMinutes, 1440), budget: d.budgetMinutes, deadlines: [],
      message: text.slice(0, MAX_MESSAGE),
    },
  };
}

/**
 * Apply the relay's answer for the page at `url`.
 * allow: a pass for that one site, at most 10, 5, then 2 minutes in a day for its kind; after it, the gate
 *   does not listen for the pass's length plus 15 minutes.
 * ask: one follow-up within 10 minutes; a second question counts as a no.
 * deny: the gate does not listen for 10 minutes. Anything malformed fails closed and changes nothing.
 */
export function applyGateAnswer(state, { url, answer, now }) {
  const ok = answer && ["allow", "deny", "ask"].includes(answer.decision) && typeof answer.reply === "string";
  if (!ok) return { state, result: { decision: "error" } };
  let s = rollover(state, now);
  const t = s.clock.floor;
  const e = entryFor(s, hostOf(url));
  if (!e) return { state, result: { decision: "error" } };
  const kind = e.kind;
  const { [kind]: _, ...followUps } = s.followUps || {};
  if (answer.decision === "allow") {
    const n = s.usage.passes[kind] || 0;
    const cap = PASS_LADDER[Math.min(n, PASS_LADDER.length - 1)];
    const minutes = Math.max(1, Math.min(cap, Math.round(Number(answer.minutes) || 1)));
    s = {
      ...s, followUps,
      passes: { ...(s.passes || {}), [e.domain]: { kind, secondsLeft: minutes * 60 } },
      usage: { ...s.usage, passes: { ...s.usage.passes, [kind]: n + 1 } },
      cooldowns: { ...(s.cooldowns || {}), [kind]: t + minutes * 60e3 + AFTER_PASS_MS },
    };
    return { state: s, result: { decision: "allow", minutes, site: e.domain, reply: answer.reply } };
  }
  if (answer.decision === "ask" && !((s.followUps || {})[kind] > t)) {
    s = { ...s, followUps: { ...(s.followUps || {}), [kind]: t + FOLLOW_UP_MS } };
    return { state: s, result: { decision: "ask", reply: answer.reply } };
  }
  const until = t + COOLDOWN_MS;
  s = { ...s, followUps, cooldowns: { ...(s.cooldowns || {}), [kind]: until } };
  return { state: s, result: { decision: "deny", until, reply: answer.reply } };
}

export function setTalk(state, on) {
  return { ...setConsent(state, "talk", on), talk: !!on };
}

export function setSorting(state, on) {
  return { ...setConsent(state, "sorting", on), sorting: !!on, unknown: on ? state.unknown || {} : {} };
}

// ---------- consent ----------

/** Whether the user said yes to the present text of this switch. */
export function consented(state, name) {
  const c = state.consent || {};
  if (CONSENT[name] && c[name] === CONSENT[name]) return true;
  return HELP_COVERS.includes(name) && c.help === CONSENT.help;
}

/**
 * The one "Claude help" switch. On: a yes to every item in WHATS_SENT; sorting also needs the browser's
 * permission to see every site, so it is on only if `sorting` (that permission) is true. Off: no yes is kept
 * for any of them, nothing is sent, and what Claude judged is forgotten.
 */
export function setHelp(state, on, { sorting = false } = {}) {
  let s = setConsent(state, "help", on);
  if (on) return { ...s, talk: true, sorting: !!sorting, unknown: sorting ? s.unknown || {} : {} };
  for (const name of HELP_COVERS) s = setConsent(s, name, false);
  return { ...s, talk: false, sorting: false, unknown: {} };
}

/** Record a yes (to the present text) or a no. Turning judging off forgets what Claude judged. */
export function setConsent(state, name, on) {
  const consent = { ...(state.consent || {}) };
  if (on && CONSENT[name]) consent[name] = CONSENT[name];
  else delete consent[name];
  let s = { ...state, consent };
  if (name === "judge" && !on) {
    s = { ...s, judged: Object.fromEntries(Object.entries(s.judged || {}).filter(([, j]) => j.by !== "claude")) };
  }
  return s;
}

/** Each switch: on, and whether the text agreed to is older than the present one (ask again). */
export function consentStatus(state) {
  const out = {};
  for (const name of Object.keys(CONSENT)) {
    const v = (state.consent || {})[name];
    out[name] = { on: consented(state, name), outdated: !!v && v !== CONSENT[name] };
  }
  return out;
}

// ---------- the rules chat ----------

/** The rules the user last asked for: what waits for the morning if anything does, else what is in force. */
export function wantedRules(state) {
  return state.pending ? state.pending.rules : state.rules;
}

/**
 * What the rules chat sends to the relay for one message, or why it sends nothing: the message, the earlier
 * turns of this conversation, the rules the user last asked for (no usage), and today's date.
 */
export function chatRequest(state, { message, history = [], now }) {
  const s = rollover(state, now);
  const text = String(message || "").trim();
  if (!consented(s, "chat")) return { refused: "no_consent" };
  if (!text) return { refused: "empty" };
  const turns = (Array.isArray(history) ? history : []).slice(-6)
    .filter((h) => h && (h.role === "user" || h.role === "gatekeeper") && typeof h.text === "string" && h.text.trim())
    .map((h) => ({ role: h.role, text: h.text.trim().slice(0, MAX_MESSAGE) }));
  return {
    payload: {
      installId: s.installId, message: text.slice(0, MAX_MESSAGE), history: turns,
      rules: rulesForChat(wantedRules(s)), today: dayKey(s.clock.floor, s.rules.dayStart),
    },
  };
}

/**
 * What the relay's answer would change, without changing anything: the rules the user would have, what
 * would apply now and what would wait for the morning. The card is built from this, so it can only show
 * what proposeRules will do when the user presses Apply.
 */
export function chatPreview(state, answer, now) {
  const reply = answer && typeof answer.reply === "string" ? answer.reply.slice(0, 500) : "";
  const question = answer && typeof answer.question === "string" && answer.question.trim() ? answer.question.slice(0, 300) : null;
  if (!answer || (!reply && !question)) return { error: "bad_answer" };
  const s = rollover(state, now);
  const { rules, skipped, needsAccess } = applyDiff(wantedRules(s), question ? [] : answer.diff);
  const r = proposeRules(s, rules, now);
  // Only what this answer changes: a loosening already waiting for the morning is not shown again.
  const before = proposeRules(s, wantedRules(s), now);
  const fresh = (list, old) => { const seen = new Set(old.map((c) => c.text)); return list.filter((c) => !seen.has(c.text)); };
  const nowChanges = fresh(r.now, before.now), later = fresh(r.later, before.later);
  return { reply, question, rules, now: nowChanges, later, from: later.length ? r.from : null, skipped: skipped.length, needsAccess };
}

// ---------- exam mode ----------
// Until a set time, every kind is closed and the gate does not talk. Starting it or moving its end later is a
// tightening and applies at once; ending it early takes the sentence below, typed in full.

export const EXAM_END_SENTENCE = "I am choosing to stop preparing for my exam";
export const MAX_EXAM_DAYS = 14;

export function examOn(state) {
  const e = state.rules && state.rules.exam;
  return !!e && e.until > ((state.clock && state.clock.floor) || 0);
}

/** Start exam mode, or move its end later (the later end wins). Applied through proposeRules: a tightening. */
export function startExam(state, { until, goal }, now) {
  const s = rollover(state, now);
  const t = s.clock.floor;
  const end = Math.min(Number(until), t + MAX_EXAM_DAYS * 86400e3);
  if (!Number.isFinite(end) || end <= t) return { state: s, refused: "bad_until" };
  const cur = examOn(s) ? s.rules.exam : null;
  const exam = { until: Math.max(end, cur ? cur.until : 0), goal: String(goal || (cur && cur.goal) || "").replace(/\s+/g, " ").trim().slice(0, 200) };
  const r = proposeRules(s, { ...wantedRules(s), exam }, now);
  return { state: r.state, exam };
}

/** End exam mode now, but only with the sentence, word for word. */
export function endExam(state, sentence, now) {
  const s = rollover(state, now);
  if (String(sentence || "").replace(/\s+/g, " ").trim() !== EXAM_END_SENTENCE) return { state: s, refused: "wrong_sentence" };
  if (!examOn(s)) return { state: s, refused: "not_on" };
  if (consented(s, "talk")) {
    // With Claude help on, ending early is a loosening: the agent holds the key, and a yes ends it next morning.
    const key = "exam:" + s.rules.exam.until;
    if (((s.denied || {})[key] || 0) > s.clock.floor) return { state: s, refused: "asked_today" };
    return { state: { ...s, loosen: { kind: "exam", changes: ["End exam mode early"], key, asked: "" } }, needsOk: true };
  }
  return { state: examEnd(s, s.clock.floor) };
}

/** Exam mode ends at `at` (now, or the next morning), in the rules in force and in what waits. */
function examEnd(s, at) {
  const cut = (r) => (r && r.exam ? { ...r, exam: at <= s.clock.floor ? null : { ...r.exam, until: Math.min(r.exam.until, at) } } : r);
  return { ...s, rules: cut(s.rules), pending: s.pending ? { ...s.pending, rules: cut(s.pending.rules) } : null };
}

// ---------- the key to loosening ----------
// With Claude help on, a loosening (more minutes, a kind no longer watched, a freer video rule, exam mode
// ended early) needs the gate agent's yes, asked like a pass: one message, then yes, no, or one question.
// A yes still applies the next morning. A no keeps the rule, and the same request waits until tomorrow.
// If the agent cannot be reached, the loosening works as without it: it waits for the morning.

export const MAX_LOOSEN_LOG = 100;

function logLoosen(s, entry) {
  const at = s.clock.floor;
  return [...(s.loosenLog || []), { at, day: s.usage.day, ...entry }].slice(-MAX_LOOSEN_LOG);
}

/** What the agent is sent for one reason, or why nothing is sent. */
export function loosenRequest(state, { message, now }) {
  const s = rollover(state, now);
  const l = s.loosen;
  const text = String(message || "").trim();
  if (!l) return { refused: "nothing_waiting" };
  if (!consented(s, "talk")) return { refused: "no_consent" };
  if (!text) return { refused: "empty" };
  return { payload: { installId: s.installId, kind: l.kind, goal: s.goal || "", changes: l.changes, asked: l.asked || "", message: text.slice(0, MAX_MESSAGE) } };
}

/** Apply the agent's answer. Anything malformed changes nothing: the loosening keeps waiting for a yes. */
export function applyLoosenAnswer(state, { answer, message = "", now }) {
  const ok = answer && ["allow", "deny", "ask"].includes(answer.decision) && typeof answer.reply === "string";
  let s = rollover(state, now);
  const l = s.loosen;
  if (!ok || !l) return { state, result: { decision: "error" } };
  const log = (decision) => logLoosen(s, { kind: l.kind, changes: l.changes, message: String(message).slice(0, MAX_MESSAGE), decision, reply: answer.reply.slice(0, 280) });
  if (answer.decision === "ask" && !l.asked) {
    return { state: { ...s, loosen: { ...l, asked: answer.reply.slice(0, 300) }, loosenLog: log("ask") }, result: { decision: "ask", reply: answer.reply } };
  }
  if (answer.decision === "allow") {
    const morning = s.usage.endsAt;
    s = l.kind === "exam" ? examEnd(s, morning) : { ...s, pending: s.pending ? { ...s.pending, ok: true, from: Math.max(s.pending.from, morning) } : null };
    return { state: { ...s, loosen: null, loosenLog: log("allow") }, result: { decision: "allow", reply: answer.reply, from: morning } };
  }
  // No (or a second question): the rule stays, and the same request waits until tomorrow.
  s = { ...s, pending: l.kind === "rules" ? null : s.pending, denied: { ...(s.denied || {}), [l.key]: s.usage.endsAt }, loosen: null, loosenLog: log("deny") };
  return { state: s, result: { decision: "deny", reply: answer.reply, until: s.usage.endsAt } };
}

/** The agent could not be reached: the loosening works as it does without one (rules wait for the morning). */
export function loosenUnavailable(state, { message = "", error = "", now }) {
  let s = rollover(state, now);
  const l = s.loosen;
  if (!l) return { state };
  s = l.kind === "exam" ? examEnd(s, s.clock.floor) : { ...s, pending: s.pending ? { ...s.pending, ok: true } : null };
  return { state: { ...s, loosen: null, loosenLog: logLoosen(s, { kind: l.kind, changes: l.changes, message: String(message).slice(0, MAX_MESSAGE), decision: "unavailable", reply: String(error).slice(0, 80) }) } };
}

// ---------- the Mac app (native messaging, contract version 1 in ~/gatekeeper-mac/docs/contract.md) ----------

export const MAC_PAGES = { today: "pages/popup.html", rules: "pages/rules.html", talk: "pages/talk.html", week: "pages/week.html", exam: "pages/rules.html#exam" };

/**
 * Today, for Gatekeeper for Mac: todaySummary() as is (each watched kind with what the engine decided:
 * left, status, fraction), plus who sent it, the pages, and exam mode. The Mac shows status as sent.
 */
export function snapshot(state, now, { extensionId } = {}) {
  const s = rollover(state, now);
  const today = todaySummary(s, now);
  return {
    ...today, type: "snapshot", v: 1, at: s.clock.floor, extensionId, pages: MAC_PAGES,
    exam: today.exam ? { until: today.exam.until, goal: today.exam.goal } : null,
  };
}

/** Whether two snapshots differ in what the Mac shows: whole minutes left, not the ring's every second. */
export function snapshotKey(snap) {
  return JSON.stringify({ ...snap, at: 0, kinds: snap.kinds.map(({ fraction, ...k }) => k), watch: snap.watch && { ...snap.watch, kinds: undefined } });
}

/**
 * One request from the Mac's reply, applied through the engine. The Mac only asks to tighten: exam.start.
 * Anything else, exam.end included, is refused: any app running as the user could write a request, so a
 * request that loosens would be a way around the rules. Ending exam mode early is typed in the extension.
 */
export function applyMacRequest(state, req, now) {
  if (!req || typeof req !== "object") return { state, refused: "bad_request" };
  if (req.type === "exam.start") return startExam(state, { until: req.until, goal: req.goal }, now);
  return { state, refused: "unknown_type" };
}
