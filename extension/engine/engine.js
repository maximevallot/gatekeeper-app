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

import { KINDS, hostOf, matches, PUBLIC_SUFFIXES, ruleDomain, isStudyHost, isSearchPage, STUDY_DOMAINS, SEARCH_ALLOW } from "./catalog.js";
export { PUBLIC_SUFFIXES, ruleDomain };
import { calendarUrl, parseIcs, EXAM_WORDS, calendarProblem, isIcs } from "./calendar.js";
import {
  MAX_JUDGED, videoKeyOf, videoSiteOf, videoRulesKey, videoName, cleanVideos, tightenVideos,
  describeVideoChanges, matchWords, applyDiff, rulesForChat,
} from "./videos.js";

export const DEFAULT_MINUTES = 15;
export const DEFAULT_DAY_START = 4; // the day, and every budget, turns over at 4:00
export const MAX_TICK_SECONDS = 5; // one report never counts more than this, so a sleeping laptop costs nothing
export const MAX_JUMP_MS = 15 * 60e3; // a clock change bigger than this, between two reads, is checked before it counts
export const MAX_DRIFT_MS = 2 * 60e3; // the clock running away from monotonic time by this much, in small steps, is checked too
export const GAP_GRACE_MS = 20e3; // after sleep or a closed browser, the day takes the clock's word if the relay doesn't answer in this long
export const UNDO_MS = 10 * 60e3; // after a tightening, going back up to what was before applies at once for this long (2026-10-18)
export const SORT_AFTER_SECONDS = 60; // an unknown site is sorted once it has been in front this long
export const SORT_RETRY_MS = 3600e3; // after a failed sort, wait an hour before asking again
export const PASS_LADDER = [10, 5, 2]; // the longest first, second and third pass for a kind in one day; then none
export const MAX_PASS_MINUTES = PASS_LADDER[0]; // the relay clamps a pass to this too
export const COOLDOWN_MS = 10 * 60e3; // after a no, the gate does not listen again for this long
export const EXAM_MAX_PASS_MINUTES = 5; // in exam mode, a pass only for a page that serves the exam, and short
export const AFTER_PASS_MS = 15 * 60e3; // after a pass ends, the gate does not listen again for this long
export const FOLLOW_UP_MS = 10 * 60e3; // one follow-up to a question, within this long
export const MAX_MESSAGE = 500;
export const JUDGE_RETRY_MS = 60e3; // a judgment in flight is asked again after this long
export const MAX_ALLOWED_VIDEOS = 50; // judged videos given a rule of their own in the browser, per list (five filters each)

// The version of each consent text. Raise one when what that switch sends changes: the user is asked again.
// talk: the gate. sorting: unknown sites. chat: the rules chat. judge: video rules judged by Claude.
export const CONSENT = { talk: 1, sorting: 1, chat: 2, judge: 2, help: 6 }; // help 5: the exam goal goes to the video judge (0.2); 6: through your account (0.3.0)

// "Claude help": one yes for everything below. Raise CONSENT.help whenever this list changes, so the user is
// asked again. The pages show this list, word for word, before the first request.
export const HELP_COVERS = ["talk", "chat", "judge", "sorting"];
export const WHATS_SENT = [
  { what: "The gate", sent: "the site's name (not its address) and kind, today's minutes and budget for that kind, your goal sentence, exam mode if it's on, the titles and dates of your next few calendar events if you connected a calendar, and what you type", when: "when you ask the gate for time" },
  { what: "Changing rules by talking", sent: "what you type, the last six messages of your talk with Gatekeeper, your rules (no usage), exam mode if it's on, the date and time, and whether a calendar is connected and when it was last read (never its link or events)", when: "when you send a message" },
  { what: "Asking to loosen a rule", sent: "the change in words, your goal sentence, and your reason as you type it", when: "when you loosen a rule or end exam mode early" },
  { what: "Video rules", sent: "a YouTube video's title and channel, the wording of your video rules, and in exam mode what your exam is for", when: "once per video you open, when you have video rules or exam mode is on" },
  { what: "Sorting new sites", sent: "the site's name and page title", when: "once per site Gatekeeper doesn't know, after a minute on it" },
];
export const SENT_TO = "These go through your Gatekeeper account on Gatekeeper's server, which asks Anthropic's Claude; Claude keeps none of it. Your account keeps your rules, your goal, today's minutes per kind and per site for 30 days, exam mode, the last 50 messages of your talk with Gatekeeper, and your requests to loosen a rule with their reasons, so your other devices follow the same rules. Never page content, addresses or other tabs, and never your calendar link: only the titles and times of the next exams on it. When this computer's clock jumps, Gatekeeper asks its server for the time, with nothing sent along.";

export function initialState() {
  return {
    version: 2,
    setupDone: false,
    goal: "",
    rules: { kinds: {}, sites: {}, siteLimits: {}, videos: [], dayStart: DEFAULT_DAY_START },
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
    thread: { turns: [], card: null }, // the one conversation with Gatekeeper, kept on this device
    log: [], // one history log, on this device: rules, loosening, passes, refusals, exam starts and ends
    loosen: null, // the loosening waiting for its reason; others wait in loosenQueue
    loosenQueue: [],
    calendar: null, // { url, events: [{ title, start }], fetchedAt, error }: a calendar link, read on this device
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
  if (!s.rules.siteLimits) s.rules = { ...s.rules, siteLimits: {} };
  // Earlier versions kept loosening apart (loosenLog); it joins the one log.
  if (Array.isArray(state.loosenLog) && state.loosenLog.length) {
    s.log = [...state.loosenLog.map((e) => ({ type: "loosen", ...e })), ...(state.log || [])].slice(-MAX_LOG);
  }
  delete s.loosenLog;
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

// ---------- a site's own limit ----------
// One site, or a domain and its subdomains, with its own daily minutes (0: closed; null: no daily limit, closed
// only in exam mode). Its time counts in its own bucket ("s:lequipe.fr") and against nothing else: not its kind,
// not another site. The longest matching domain wins, and a site's own limit comes before any kind.

export const siteKey = (domain) => "s:" + domain;

/** The registrable domain of a host: m.youtube.com → youtube.com, news.bbc.co.uk → bbc.co.uk. */
export function baseDomain(host) {
  const parts = String(host || "").split(".");
  const two = parts.slice(-2).join(".");
  return PUBLIC_SUFFIXES.has(two) && parts.length > 2 ? parts.slice(-3).join(".") : two;
}

function siteLimitFor(s, host) {
  if (!host) return null;
  let best = null;
  for (const [domain, minutes] of Object.entries(s.rules.siteLimits || {})) {
    if (matches(host, domain) && (!best || domain.length > best.domain.length)) best = { domain, minutes };
  }
  return best;
}

/** A study site: a university's, a course tool's (catalog.js), one sorted as study, or one the user named. */
export function studySite(s, host) {
  if (!host) return false;
  if (isStudyHost(host)) return true;
  return (s.rules.study || []).some((d) => matches(host, d));
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
export function rollover(state, now, { mono, run } = {}) {
  let s = state;
  const c = s.clock || { floor: 0 };
  const n = (Number(now) || 0) + (c.offset || 0);
  let floor = c.floor || 0, strict = c.strict ?? floor, held = c.held || null, drift = c.drift || 0, last = c.last || null;
  if (!c.guard || !floor) {
    // Unguarded, or the very first reading of a new install: taken as it is.
    floor = strict = Math.max(n, floor);
    if (c.guard && mono !== undefined) last = { wall: n, mono, run };
  } else if (mono === undefined) {
    // A read between ticks (a page, an alarm): time moves only a little here; anything bigger waits for the tick.
    if (!held && n > floor && n - floor <= MAX_JUMP_MS) floor = strict = n;
    else if (!held && floor && Math.abs(n - floor) > MAX_JUMP_MS) held = { kind: "jump", seen: n };
  } else {
    // The worker's tick: wall time is compared with monotonic time (QA round 3, gate N2 and first-run N1).
    const dm = last && last.run === run && mono >= last.mono ? mono - last.mono : null; // null: the worker restarted
    const dw = last ? n - last.wall : n - floor;
    const bigGap = dm === null ? floor > 0 && n - floor > MAX_JUMP_MS : dw - dm > MAX_JUMP_MS;
    const gap = bigGap || (!!held && held.kind !== "drift");
    if (gap) {
      if (held && held.kind === "drift") held = null; // a night asleep after small steps still counts for the day
      // The browser was closed or the computer slept (the clock doesn't run in sleep), or the clock was moved in one
      // go. For the day it is real time once the relay hasn't answered for GAP_GRACE_MS; exam mode and waiting
      // loosenings keep to monotonic time until the relay's time comes (strict).
      // A worker that just started means the browser wasn't running: that counts at once.
      if (!held || held.kind === "jump") held = { kind: "gap", seen: n, mono, run, closed: dm === null };
      if (held.closed || held.run !== run || mono - held.mono >= GAP_GRACE_MS) floor = Math.max(floor, n);
      strict += Math.max(0, Math.min(dm ?? 0, MAX_JUMP_MS));
    } else {
      // Running: small steps add up (14 minutes at a time is still a moved clock).
      drift += dm === null ? 0 : dw - dm;
      if (!held && Math.abs(drift) > MAX_DRIFT_MS) held = { kind: "drift", seen: n, mono, run };
      if (held) { floor += Math.max(0, dm); strict += Math.max(0, dm); }
      else floor = strict = Math.max(floor, n);
    }
    last = { wall: n, mono, run };
  }
  strict = Math.min(Math.max(strict, c.strict ?? 0), floor);
  const t = floor;
  const same = c.floor === floor && (c.strict ?? c.floor) === strict && c.held === held && (c.drift || 0) === drift && c.last === last;
  if (!same) {
    const next = { ...c, floor, strict, drift, last };
    if (held) next.held = held; else delete next.held;
    if (!c.guard) { delete next.strict; delete next.drift; delete next.last; }
    s = { ...s, clock: next };
  }
  const ending = !s.usage.endsAt || t >= s.usage.endsAt;
  // The day that ends goes into the week's history, under the rules it was lived by.
  if (ending && s.usage.day) s = { ...s, history: [...(s.history || []).filter((h) => h.day !== s.usage.day), daySummary(s)].slice(-HISTORY_DAYS) };
  // A loosening applies in the morning only once the agent said yes (or with Claude help off, the morning
  // alone). What the agent approved earlier applies even if a later request is still waiting for its yes.
  // A loosening waiting for the morning waits for time that is sure (strict), not for a moved clock.
  if (s.pending && strictNow(s) >= s.pending.from) {
    if (s.pending.ok !== false) s = { ...s, rules: s.pending.rules, pending: null };
    else if (s.pending.approved) s = { ...s, rules: s.pending.approved, pending: { ...s.pending, approved: null, from: s.usage.endsAt > t ? s.usage.endsAt : nextDayStart(t, s.rules.dayStart) } };
  }
  if (ending) {
    s = {
      ...s,
      usage: { day: dayKey(t, s.rules.dayStart), endsAt: nextDayStart(t, s.rules.dayStart), seconds: {}, passes: {}, gates: 0 },
      unknown: {}, followUps: {},
    };
  }
  return s;
}

/**
 * The hands asked the relay for the time after a jump: `server` is its time, `local` this computer's clock
 * when the answer came. Gatekeeper then reads time as the computer's clock plus the difference, so a clock set
 * forward or back counts for nothing, and real time that passed (a night asleep) counts in full.
 */
export function confirmTime(state, { server, local, mono, run }) {
  const c = state.clock || { floor: 0 };
  if (!Number.isFinite(server) || !Number.isFinite(local)) return state;
  const offset = Math.abs(server - local) > 2 * 60e3 ? Math.round(server - local) : 0;
  const { held, ...rest0 } = c;
  const floor = Math.round(server);
  // From the relay's time on, wall and monotonic time are compared afresh.
  const rest = { ...rest0, strict: floor, drift: 0, last: mono === undefined ? null : { wall: floor, mono, run } };
  // Moments counted up to a wrong time ahead come back to the true one, so time is counted again from now.
  const u = state.usage || {};
  const upTo = Object.fromEntries(Object.entries(u.upTo || {}).map(([b, m]) => [b, Math.min(m, floor)]));
  return { ...state, usage: { ...u, upTo, passUpTo: Math.min(u.passUpTo || 0, floor) }, clock: { ...rest, offset, floor, checkedAt: floor } };
}

/** Time that is sure: the relay's, or the clock as far as monotonic time agrees. Exam mode keeps to it. */
export function strictNow(state) {
  const c = state.clock || {};
  return c.strict ?? c.floor ?? 0;
}

/** Whether the clock jumped and the hands should check the time. */
export function timeCheckNeeded(state) {
  return !!(state.clock && state.clock.held);
}

/** The hands guard the clock (in the browser); the engine's own tests read `now` as given. */
export function guardClock(state) {
  return state.clock && state.clock.guard ? state : { ...state, clock: { ...(state.clock || { floor: 0 }), guard: true } };
}

// ---------- the week ----------
// Kept on this device only: one line per day, the minutes on watched sites, the minutes allowed, how many
// times a gate closed a site, and how many passes the gate granted.

export const HISTORY_DAYS = 30;

function daySummary(s) {
  const seconds = Object.values(s.usage.seconds || {}).reduce((a, b) => a + b, 0) - (s.usage.twice || 0);
  const allowed = Object.values(s.rules.kinds || {}).reduce((a, k) => a + (k.minutes || 0), 0)
    + Object.values(s.rules.siteLimits || {}).reduce((a, m) => a + (m || 0), 0);
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
  // Ended early (skipped, or limits set): its summary is not offered later as "ready" (QA round 2, first-run H2).
  return s.watch ? { ...s, watch: { ...s.watch, until: Math.min(s.watch.until, s.clock.floor), ended: true, shown: true } } : s;
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
    loosenAsked: (s.log || []).filter((e) => e.type === "loosen" && e.at > t - 7 * 86400e3 && e.decision !== "ask").length,
    loosenAllowed: (s.log || []).filter((e) => e.type === "loosen" && e.at > t - 7 * 86400e3 && e.decision === "allow").length,
    examStarts: (s.log || []).filter((e) => e.type === "exam.start" && e.at > t - 7 * 86400e3).length,
    withheld: withheldWeek(s, t),
  };
}

// ---------- site access withheld ----------
// Maxime's answer on QA round 2 #3, "Make it visible": withholding site access can't be prevented (it is about
// as easy as turning the extension off), so it is shown plainly while it lasts and kept in the history.

/** The hands report which watched domains Gatekeeper can't see now; each period is kept in the one log. */
export function noteWithheld(state, domains, now) {
  const s = rollover(state, now);
  const t = s.clock.floor;
  const list = [...new Set(domains || [])].sort();
  const cur = s.withheld || null;
  if (JSON.stringify(cur ? cur.domains : []) === JSON.stringify(list)) return s;
  let n = s;
  if (cur && t > cur.from) n = { ...n, log: logEvent(n, "access.withheld", { domains: cur.domains.slice(0, 100), from: cur.from, to: t, minutes: Math.round((t - cur.from) / 60e3) }) };
  return { ...n, withheld: list.length ? { domains: list, from: t } : null };
}

/** The week's withheld access: total minutes, and the domains, the most often withheld first. */
function withheldWeek(s, t) {
  const since = t - 7 * 86400e3;
  const periods = (s.log || []).filter((e) => e.type === "access.withheld" && e.to > since).map((e) => ({ domains: e.domains, from: Math.max(e.from, since), to: e.to }));
  if (s.withheld) periods.push({ domains: s.withheld.domains, from: Math.max(s.withheld.from, since), to: t });
  if (!periods.length) return null;
  const count = {};
  for (const p of periods) for (const d of p.domains) count[d] = (count[d] || 0) + (p.to - p.from);
  const domains = Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b));
  return { minutes: Math.round(periods.reduce((a, p) => a + (p.to - p.from), 0) / 60e3), domains };
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
  // One row per site with its own limit, under the kinds.
  const sites = Object.entries(s.rules.siteLimits || {}).sort(([a], [b]) => a.localeCompare(b)).map(([d, minutes]) => {
    const used = usedSeconds(s, siteKey(d));
    const short = d.split(".").slice(0, -1).join(".") || d; // "lequipe" under its ring
    if (minutes === null) return { kind: siteKey(d), site: d, label: d, short, minutes: null, left: null, status: "open", examOnly: true, fraction: 1 };
    const left = Math.max(0, Math.ceil((minutes * 60 - used) / 60));
    const status = minutes === 0 ? "closed" : used >= minutes * 60 ? "spent" : "open";
    return { kind: siteKey(d), site: d, label: d, short, minutes, left, status, fraction: minutes ? Math.max(0, (minutes * 60 - used) / (minutes * 60)) : 0 };
  });
  const watch = watching(s) ? {
    day: Math.min(WATCH_DAYS, Math.floor((s.clock.floor - s.watch.from) / 86400e3) + 1), of: WATCH_DAYS, until: s.watch.until,
    kinds: Object.keys(KINDS).map((k) => ({ kind: k, label: label(k), short: SHORT[k] || label(k), used: Math.floor(usedSeconds(s, k) / 60) })),
  } : null;
  const exam = examOn(s) ? { ...s.rules.exam } : null;
  if (exam) for (const k of [...kinds, ...sites]) { k.status = "closed"; k.exam = true; }
  return { kinds, sites, goal: s.goal || "", reopensAt: s.usage.endsAt, setupDone: !!s.setupDone, waiting: !!s.pending, watch, watchReady: watchReady(s), exam, offer: examOffer(s, now) };
}

const usedSeconds = (s, kind) => s.usage.seconds[kind] || 0;

function passFor(s, domain, ladder) {
  const p = domain && (s.passes || {})[domain];
  return p && p.kind === ladder && p.secondsLeft > 0 ? p : null;
}

/**
 * What a site's passes, cooldowns and follow-ups count against (QA round 2, H1): its kind if it has one of the
 * five, else its registrable domain. A site's own limit never starts a fresh ladder: m.youtube.com with a limit
 * of its own still shares Video's three passes and Video's cooldown.
 */
function ladderKey(s, url) {
  // A catalog site keeps its catalog kind's ladder wherever the user moved it (QA round 3, N4).
  const host = hostOf(url);
  const c = host && catalogMatch(host);
  if (c) return c.kind;
  const k = kindOf(s, url);
  return KINDS[k] ? k : "d:" + baseDomain(siteDomain(url) || "");
}

/**
 * The decision for a site with its own limit. Outside a watched kind its time counts only against itself.
 * Inside one (instagram.com in Social media) it counts against both, and the smaller wins (QA round 2, H3):
 * a site's own limit only ever tightens. null ("only in exam mode") leaves the site to its kind.
 */
function siteDecision(s, url, title, lim) {
  const key = siteKey(lim.domain);
  const ladder = ladderKey(s, url);
  const used = usedSeconds(s, key);
  const pass = passFor(s, lim.domain, ladder);
  const base = { kind: key, bucket: key, ladder, site: lim.domain, passDomain: lim.domain, label: lim.domain, title, usedMinutes: Math.floor(used / 60), reopensAt: s.usage.endsAt };
  if (examOn(s)) {
    // Exam mode closes a site's own limit too, null ("only in exam mode") included.
    if (pass) return { ...base, verdict: "allow", watched: true, pass: true, exam: { ...s.rules.exam }, leftMinutes: Math.ceil(pass.secondsLeft / 60) };
    return { ...base, verdict: "block", watched: true, exam: { ...s.rules.exam }, budgetMinutes: lim.minutes, reopensAt: s.rules.exam.until };
  }
  if (lim.minutes === null) return null;
  const under = kindOf(s, url);
  const kindRule = KINDS[under] && !watching(s) ? s.rules.kinds[under] : null;
  const ownLeft = Math.max(0, lim.minutes * 60 - used);
  const kindUsed = kindRule ? usedSeconds(s, under) : 0;
  const kindLeft = kindRule ? Math.max(0, kindRule.minutes * 60 - kindUsed) : Infinity;
  const d = { ...base, watched: true, buckets: kindRule ? [key, under] : [key], budgetMinutes: lim.minutes, leftMinutes: Math.ceil(Math.min(ownLeft, kindLeft) / 60) };
  if (watching(s)) return { ...d, verdict: "allow", watching: true, buckets: [key, ...(KINDS[under] ? [under] : [])] };
  if (pass) return { ...d, verdict: "allow", pass: true, leftMinutes: Math.ceil(pass.secondsLeft / 60) };
  // The kind is what closes it: the gate speaks of the kind, as for any site in it.
  const byKind = kindRule && (kindRule.minutes === 0 || kindLeft <= 0) && !(lim.minutes === 0 || ownLeft <= 0);
  if (byKind) {
    return { ...d, kind: under, site: undefined, label: label(under), usedMinutes: Math.floor(kindUsed / 60), budgetMinutes: kindRule.minutes, leftMinutes: 0, verdict: kindRule.minutes === 0 ? "block" : "gate" };
  }
  if (lim.minutes === 0) return { ...d, verdict: "block" };
  return { ...d, verdict: ownLeft <= 0 ? "gate" : "allow" };
}

// ---------- the decision ----------

/**
 * What to do with a page. verdict: "allow" (not watched, time left, or a pass for this site),
 * "gate" (today's budget is spent), "block" (0 minutes).
 */
export function decide(state, { url, title = "", now }) {
  const s = rollover(state, now);
  const host = hostOf(url);
  const lim = siteLimitFor(s, host);
  if (examOn(s)) {
    // Exam mode closes everything but study (decision 2 of 2026-10-17; QA round 2, H4): every kind, watched or
    // not, sites sorted as work or other, and sites not sorted yet. A video rule that makes videos free still holds.
    const video = videoDecision(s, url, title);
    if (video && video.verdict === "allow" && !video.watched) return video;
    // A video about the exam's subject plays, for the whole video (tester case, 2026-10-18).
    if (examVideoOn(s, url)) return { verdict: "allow", kind: kindOf(s, url), watched: false, study: true, studyVideo: true };
    if (lim) return siteDecision(s, url, title, lim);
    const kind = kindOf(s, url);
    // Study sites and search result pages stay open (Maxime's tester run, 2026-10-18): exam mode never strands a
    // student from Canvas because a search page or the course site was closed.
    if (!host || kind === "study" || studySite(s, host) || isSearchPage(url)) return { verdict: "allow", kind, watched: false, study: true };
    const e = entryFor(s, host);
    const domain = e ? e.domain : siteDomain(url);
    const ladder = ladderKey(s, url);
    const known = !!KINDS[kind];
    const base = { kind, bucket: known ? kind : ladder, ladder, passDomain: domain, label: known ? label(kind) : domain, watched: true, title, exam: { ...s.rules.exam } };
    // A pass the gate gave for this page because it serves the exam (decision of 2026-10-17).
    const pass = passFor(s, domain, ladder);
    if (pass) return { ...base, verdict: "allow", pass: true, leftMinutes: Math.ceil(pass.secondsLeft / 60) };
    return { ...base, verdict: "block", unsorted: kind === null || undefined,
      usedMinutes: Math.floor(usedSeconds(s, base.bucket) / 60), budgetMinutes: known ? (s.rules.kinds[kind] || {}).minutes ?? null : null, reopensAt: s.rules.exam.until };
  }
  if (watching(s)) {
    // The watch week counts every kind and blocks nothing.
    const own = lim && siteDecision(s, url, title, lim);
    if (own) return own;
    const kind = kindOf(s, url);
    const used = KINDS[kind] ? usedSeconds(s, kind) : 0;
    return KINDS[kind] ? { verdict: "allow", kind, bucket: kind, label: label(kind), watched: true, watching: true, usedMinutes: Math.floor(used / 60) } : { verdict: "allow", kind, watched: false };
  }
  const video = videoDecision(s, url, title);
  if (video) return video;
  const own = lim && siteDecision(s, url, title, lim);
  if (own) return own;
  const kind = kindOf(s, url);
  const rule = kind && s.rules.kinds[kind];
  if (!rule) return { verdict: "allow", kind, watched: false };
  const budget = rule.minutes * 60;
  const used = usedSeconds(s, kind);
  const e = entryFor(s, host);
  const ladder = ladderKey(s, url);
  const base = {
    kind, bucket: kind, ladder, passDomain: e && e.domain, label: label(kind), watched: true, title,
    usedMinutes: Math.floor(used / 60), budgetMinutes: rule.minutes,
    leftMinutes: Math.max(0, Math.ceil((budget - used) / 60)),
    reopensAt: s.usage.endsAt,
  };
  const pass = passFor(s, e && e.domain, ladder);
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
export function tick(state, { url, title = "", focused, active, seconds, now, audible = [], mono, run }) {
  let s = rollover(state, now, { mono, run });
  const t = s.clock.floor;
  const add = clamp(seconds);
  // The report is a span of real time (one-per-person design, step 1): [t - add, t], or, while the clock stands
  // still (set back, or a jump not checked yet), the next `add` seconds after the last span, so time still
  // passes and a pass still runs out. Passes run down by it first.
  const addMs = Math.round(add * 1000);
  const last = s.usage.spanEnd || 0;
  const to = add ? (t > last ? t : last + addMs) : t;
  const from = to - addMs;
  if (add) s = { ...s, usage: { ...s.usage, spanEnd: to } };
  s = runPasses(s, from, to);
  const counted = new Set();
  const twice = new Set(); // a site's own bucket also counted in its kind's: the week counts that time once
  const count = (d) => {
    for (const b of d.buckets || [d.bucket]) counted.add(b);
    if ((d.buckets || []).length > 1) twice.add(d.buckets[0]);
  };
  const front = decide(s, { url, title, now: t });
  if (focused && active && front.watched && front.verdict === "allow") count(front);
  for (const u of audible) {
    const d = decide(s, { url: u, now: t });
    if (d.watched && d.verdict === "allow") count(d);
  }
  const span = add ? { from, to, buckets: [...counted], twice: [...twice] } : null;
  if (span) s = countSpan(s, span);
  // A site nobody has sorted: once it has been in front for a minute, ask the relay once.
  let sort = null;
  const domain = siteDomain(url);
  if (front.kind === null && s.sorting && focused && active && domain) {
    const e = (s.unknown || {})[domain] || { seconds: 0 };
    const next = { ...e, seconds: e.seconds + add };
    const asking = e.asking && t - e.asking < 120e3; // a call in flight; a lost one is retried after 2 minutes
    // In exam mode a site Gatekeeper doesn't know is checked as soon as it opens, not after a minute.
    if ((next.seconds >= SORT_AFTER_SECONDS || examOn(s)) && !asking && !(e.retryAt > t)) {
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
  return { state: s, decision: decide(s, { url, title, now: t }), sort, judge, span };
}

// ---------- time as spans (one Gatekeeper per person, step 1) ----------
// Time is counted as spans of real time, not as reports. For each bucket the usage keeps the moment it has
// counted up to (usage.upTo), and a span adds only what lies after it: two devices with YouTube in front at the
// same moment count it once. Passes run down the same way, by one moment for all of them (usage.passUpTo), so a
// 5-minute pass lasts 5 minutes with two browsers open. One device behaves exactly as before.

/** Run the passes down by the part of [from, to] not already run. */
function runPasses(s, from, to) {
  const up = s.usage.passUpTo || 0;
  const add = Math.max(0, to - Math.max(from, up)) / 1000;
  if (!(add > 0)) return s;
  const passes = {};
  for (const [d, p] of Object.entries(s.passes || {})) if (p.secondsLeft - add > 0) passes[d] = { ...p, secondsLeft: p.secondsLeft - add };
  return { ...s, passes, usage: { ...s.usage, passUpTo: Math.max(up, to) } };
}

/** Count one span against its buckets, each only past the moment it was counted up to. */
function countSpan(s, { from, to, buckets = [], twice = [] }) {
  const sec = { ...s.usage.seconds }, upTo = { ...(s.usage.upTo || {}) };
  let extra = 0;
  for (const b of new Set(buckets)) {
    const add = Math.max(0, to - Math.max(from, upTo[b] || 0)) / 1000;
    if (!(add > 0)) continue;
    sec[b] = (sec[b] || 0) + add;
    upTo[b] = Math.max(upTo[b] || 0, to);
    if (twice.includes(b)) extra += add;
  }
  return { ...s, usage: { ...s.usage, seconds: sec, upTo, twice: (s.usage.twice || 0) + extra } };
}

export const MAX_SPAN_MS = MAX_TICK_SECONDS * 1000;

/**
 * Spans another device reported, in its own clock: `shift` turns them into this clock (the account's time minus
 * the device's at the same moment). Each is cut to at most MAX_SPAN_MS, to today, and to no later than now, so
 * a device's clock set forward or back changes nothing.
 */
export function applySpans(state, spans, { shift = 0, now } = {}) {
  let s = rollover(state, now === undefined ? (state.clock && state.clock.floor) || 0 : now);
  const t = s.clock.floor;
  const dayFrom = s.usage.endsAt - 86400e3;
  for (const sp of Array.isArray(spans) ? spans : []) {
    if (!sp || !Number.isFinite(sp.from) || !Number.isFinite(sp.to)) continue;
    const to = Math.min(sp.to + shift, t);
    const from = Math.max(sp.from + shift, to - MAX_SPAN_MS, dayFrom);
    if (!(to > from)) continue;
    s = runPasses(s, from, to);
    const buckets = (Array.isArray(sp.buckets) ? sp.buckets : []).filter((b) => typeof b === "string" && b.length < 120).slice(0, 8);
    s = countSpan(s, { from, to, buckets, twice: Array.isArray(sp.twice) ? sp.twice : [] });
  }
  return s;
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

// ---------- study videos in exam mode (tester case, 2026-10-18) ----------
// In exam mode a YouTube video about the exam's subject plays, with no talk at the gate. Each video is judged once
// against the exam's goal ("stats exam"), as a video rule would be: by AI help through /judge (one rule, id "exam"),
// or by the goal's words in the title on this device. Watch pages only: never YouTube's home feed, Shorts or
// comments. It plays for the whole video, with no pass to run out; only while exam mode is on.

const GOAL_STOP = new Set(["exam", "exams", "midterm", "midterms", "final", "finals", "quiz", "test", "tests", "for", "the", "and",
  "my", "mode", "study", "studying", "class", "course", "prep", "review", "of", "in", "on", "to", "an", "partiel", "examen"]);

/** The goal's own words, for matching titles without AI help: "stats exam" → ["stats"]. */
export function goalWords(goal) {
  return [...new Set(String(goal || "").toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length >= 3 && !GOAL_STOP.has(w)))].slice(0, 12);
}

/** A video's key on a watch page (youtube.com/watch, youtu.be), or null: Shorts and live pages are not study. */
export function examVideoKey(url) {
  const key = videoKeyOf(url);
  if (!key) return null;
  try {
    const u = new URL(url);
    return u.pathname === "/watch" || matches(u.hostname, "youtu.be") ? key : null;
  } catch { return null; }
}

const examGoalKey = (s) => "exam:" + ((s.rules.exam && s.rules.exam.goal) || "");
function examRule(s) {
  const goal = (s.rules.exam && s.rules.exam.goal) || "";
  return { id: "exam", site: "youtube.com", about: goal || "the subject of the exam", except: "", words: { match: goalWords(goal), except: [] } };
}

/** Whether this watch page, in exam mode, has been judged on topic for the exam's goal. */
function examVideoOn(s, url) {
  const key = examVideoKey(url);
  const j = key && (s.examJudged || {})[key];
  return !!(j && j.goal === examGoalKey(s) && j.on);
}

/** Whether this page is a video that a video rule may apply to and that has no judgment yet. */
export function needsJudgment(state, url) {
  if (examOn(state) && examVideoKey(url)) {
    const j = (state.examJudged || {})[examVideoKey(url)];
    return !j || j.goal !== examGoalKey(state);
  }
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
  const exam = examOn(state);
  // In exam mode the video is judged against the exam (the relay's /judge reads `exam` and answers `forExam`); on
  // this device, by the goal's words. The student's own video rules go along as usual.
  const rules = exam ? [examRule(state)] : videoRules(state, site);
  const t = String(title).replace(/\s+/g, " ").trim().slice(0, 200);
  const c = String(channel).replace(/\s+/g, " ").trim().slice(0, 100);
  if (!rules.length) return { local: null };
  if (!consented(state, "judge") || !t) return { local: matchWords(rules, { title: t, channel: c }), exam };
  const sent = (exam ? videoRules(state, site) : rules).map(({ id, about, except }) => ({ id, about, except }));
  return {
    payload: { installId: state.installId, site, title: t, channel: c, rules: sent, ...(exam ? { exam: examForRelay(state) } : {}) },
    fallback: matchWords(rules, { title: t, channel: c }), exam,
  };
}

/** Keep which rule a video falls under (null: none), under the rules' present wording. */
export function recordJudgment(state, key, rule, by, now, { exam = false } = {}) {
  const t = Math.max(Number(now) || 0, (state.clock && state.clock.floor) || 0);
  if (exam) {
    // Judged against the exam's goal: on topic plays; kept per goal, so another exam is judged again.
    const examJudged = { ...(state.examJudged || {}), [key]: { on: rule === "exam", goal: examGoalKey(state), by, at: t } };
    const { [key]: _, ...judging } = state.judging || {};
    return { ...state, examJudged: Object.fromEntries(Object.entries(examJudged).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_JUDGED)), judging };
  }
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
  for (const d of Object.keys(state.rules.siteLimits || {})) out.push(d);
  return [...new Set(out)].filter((d) => watchedDomain(state, d));
}

// Whether one domain is watched: by its own limit first (null: only in exam mode), else by its kind. A site the
// user moved to an unwatched kind is not caught by its catalog entry.
function watchedDomain(state, d) {
  const lim = siteLimitFor(state, d);
  if (lim) return lim.minutes !== null || examOn(state);
  const k = kindOf(state, "https://" + d + "/");
  return !!KINDS[k] && (examOn(state) || !!state.rules.kinds[k]);
}

export function closedDomains(state, now) {
  const s = rollover(state, now);
  const closed = new Set(closedKinds(s, now));
  return watchedDomains(s).filter((d) => {
    const lim = siteLimitFor(s, d);
    if (lim) return decide(s, { url: "https://" + d + "/", now }).verdict !== "allow";
    const kind = kindOf(s, "https://" + d + "/");
    const p = (s.passes || {})[d];
    return closed.has(kind) && !(p && p.kind === kind && p.secondsLeft > 0);
  });
}

/**
 * Sites with their own limit and time left that lie inside a closed domain (cooking.nytimes.com with News
 * closed): the hands let them through above the domain's block, since they count against nothing else.
 */
export function openInsideClosed(state, now) {
  const s = rollover(state, now);
  const closed = closedDomains(s, now);
  return Object.keys(s.rules.siteLimits || {}).filter((d) => !closed.includes(d) && closed.some((c) => c !== d && matches(d, c))
    && decide(s, { url: "https://" + d + "/", now }).verdict === "allow");
}

/**
 * What the hands write into the browser. `redirect`: closed sites, sent to the gate before they load
 * (needs the extension's access to the site). `block`: closed sites again, for embedded frames and for a
 * site whose access was withheld, where a redirect cannot fire; plus every watched site whose access was
 * withheld, since time there cannot be counted. `withheld` lists the domains the browser does not let
 * the extension see.
 */
export function enforcement(state, now, { withheld = [], seeAll = false } = {}) {
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
  if (examOn(s)) {
    for (const [key, j] of Object.entries(s.examJudged || {}).sort((a, b) => b[1].at - a[1].at)) {
      if (j.on && j.goal === examGoalKey(s)) allowVideos.push(key);
    }
  }
  const recent = Object.entries(s.judged || {}).sort((a, b) => b[1].at - a[1].at);
  for (const [key, j] of recent) {
    if (!j.rule) continue;
    const d = decide(s, { url: "https://www.youtube.com/watch?v=" + key.slice(3), now });
    if (!d.video) continue;
    if (d.verdict === "allow") { if (!(youtubeBlind && d.watched)) allowVideos.push(key); }
    else closeVideos.push(key);
  }
  // Exam mode closes everything but study (QA round 2, H4). Where Gatekeeper may see every site, every page goes
  // to the gate before it loads, except sites sorted as study and sites with a pass; the gate sorts the rest.
  const examAll = examOn(s) && seeAll ? {
    allow: [...new Set([
      ...Object.entries(s.sorted || {}).filter(([, k]) => k === "study").map(([d]) => d),
      ...Object.entries(s.passes || {}).filter(([, p]) => p.secondsLeft > 0).map(([d]) => d),
      ...STUDY_DOMAINS, ...(s.rules.study || []), "edu",
    ])].filter((d) => !closed.includes(d)),
    allowUrls: SEARCH_ALLOW,
  } : null;
  return {
    examAll,
    redirect: closed, block: [...new Set([...closed, ...blind])], blind, allowSites: openInsideClosed(s, now).filter((d) => !hidden.has(d)),
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
    const host = ruleDomain(d);
    if (host && KINDS[k]) sites[host] = k;
  }
  const siteLimits = {};
  for (const [d, m] of Object.entries(r.siteLimits || {})) {
    const host = ruleDomain(d);
    if (host) siteLimits[host] = m === null ? null : clampMinutes(m);
  }
  const ds = Number(r.dayStart);
  const dayStart = Number.isInteger(ds) && ds >= 0 && ds <= 23 ? ds : fallback.dayStart;
  const e = r.exam;
  const exam = e && Number.isFinite(Number(e.until)) ? { until: Number(e.until), goal: String(e.goal || "").replace(/\s+/g, " ").trim().slice(0, 200),
    ...(Number.isFinite(Number(e.from)) && e.from ? { from: Number(e.from) } : {}),
    at: Number.isFinite(Number(e.at)) && e.at ? Math.min(Number(e.at), Number(e.until)) : Number(e.until) } : null;
  const study = [...new Set((Array.isArray(r.study) ? r.study : []).map(ruleDomain).filter(Boolean))].slice(0, 100);
  return { kinds, sites, siteLimits, study, videos: cleanVideos(r.videos), dayStart, exam };
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
  // How open a domain is under some rules: time left today, minutes a day, and whether exam mode closes it.
  // A site's own limit inside a watched kind counts against both, so the smaller wins.
  const open = (rules, dd) => {
    const st = { ...state, rules: { ...rules, kinds } };
    const lim = siteLimitFor(st, dd);
    const k = kindOf(st, "https://" + dd + "/");
    const kl = KINDS[k] ? left(k) : Infinity, kp = KINDS[k] ? perDay(k) : Infinity;
    if (!lim || lim.minutes === null) return { left: kl, perDay: kp, exam: !!lim || k !== "study" };
    const own = lim.minutes === 0 ? 0 : Math.max(0, lim.minutes * 60 - usedSeconds(st, siteKey(lim.domain)));
    return { left: Math.min(own, kl), perDay: Math.min(lim.minutes, kp), exam: true };
  };
  // A rule on a domain covers every site under it, so it is judged by all of them (QA round 2, C4): a rule on
  // ycombinator.com also reaches news.ycombinator.com, which the catalog has in News.
  const known = [...new Set([
    ...Object.values(KINDS).flatMap((k) => k.domains), ...Object.keys(cur.sites || {}), ...Object.keys(next.sites || {}),
    ...Object.keys(state.sorted || {}), ...Object.keys(cur.siteLimits || {}), ...Object.keys(next.siteLimits || {}),
  ])];
  const reach = (d) => [d, ...known.filter((x) => x !== d && matches(x, d))];
  const noLooser = (a, b, d) => reach(d).every((dd) => {
    const x = open(a, dd), y = open(b, dd);
    return y.left <= x.left && y.perDay <= x.perDay && (y.exam || !x.exam);
  });
  const sites = {};
  for (const d of new Set([...Object.keys(cur.sites || {}), ...Object.keys(next.sites || {})])) {
    const asked = { ...(cur.sites || {}) };
    if (next.sites && d in next.sites) asked[d] = next.sites[d]; else delete asked[d];
    const stricter = noLooser(cur, { ...cur, sites: asked }, d);
    const pick = stricter ? next.sites : cur.sites;
    if (pick && d in pick) sites[d] = pick[d];
  }
  // A site's own limit applies now only if it leaves no site under it more time today or a day than before,
  // and exam mode still closes what it closed. Raising one, removing one, or adding one where it would open
  // something waits.
  const siteLimits = {};
  const curLimits = cur.siteLimits || {}, nextLimits = next.siteLimits || {};
  for (const d of new Set([...Object.keys(curLimits), ...Object.keys(nextLimits)])) {
    const asked = { ...curLimits };
    if (d in nextLimits) asked[d] = nextLimits[d]; else delete asked[d];
    const stricter = noLooser({ ...cur, sites, siteLimits: curLimits }, { ...cur, sites, siteLimits: asked }, d);
    const pick = stricter ? nextLimits : curLimits;
    if (d in pick) siteLimits[d] = pick[d];
  }
  // A study site opens in exam mode: naming one applies now outside exam mode, and waits during it. Removing one
  // applies now.
  const examNow = examOn(state) || !!(next.exam && next.exam.until > strictNow(state));
  const curStudy = cur.study || [], nextStudy = next.study || [];
  const study = examNow ? nextStudy.filter((d) => curStudy.includes(d)) : nextStudy.slice();
  const youtube = kindUnder(cur, "youtube.com"); // the kind YouTube's own pages count against today
  const videos = tightenVideos(cur.videos || [], next.videos || [], { watched: !!(youtube && kinds[youtube]) });
  // Exam mode in force can only be extended now; ending or shortening it waits (the sentence ends it at once).
  const t = strictNow(state);
  const a = cur.exam && cur.exam.until > t ? cur.exam : null, b = next.exam || null;
  // The exam's own time in force never moves earlier: ending at once depends on it.
  const exam = a ? (b && b.until >= a.until ? { ...b, at: Math.max(a.at || a.until, b.at || b.until) } : a) : b;
  return { ...next, kinds, sites, siteLimits, study, videos, dayStart: cur.dayStart, exam };
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
    if (a && !b) out.push({ kind: k, target: "kind:" + k, text: `${label(k)}: limit removed` });
    else if (!a && b) out.push({ kind: k, target: "kind:" + k, text: `${label(k)}: ${minutesText(b.minutes)}` });
    else if (a.minutes !== b.minutes) out.push({ kind: k, target: "kind:" + k, text: `${label(k)}: ${minutesText(a.minutes)} → ${minutesText(b.minutes)}` });
  }
  const sites = new Set([...Object.keys(cur.sites || {}), ...Object.keys(next.sites || {})]);
  for (const d of sites) {
    const a = (cur.sites || {})[d], b = (next.sites || {})[d];
    if (a && !b) out.push({ site: d, target: "site:" + d, text: `${d}: no longer counted as ${label(a).toLowerCase()}` });
    else if (!a && b) out.push({ site: d, target: "site:" + d, text: `${d}: counted as ${label(b).toLowerCase()}` });
    else if (a !== b) out.push({ site: d, target: "site:" + d, text: `${d}: ${label(a).toLowerCase()} → ${label(b).toLowerCase()}` });
  }
  const limits = new Set([...Object.keys(cur.siteLimits || {}), ...Object.keys(next.siteLimits || {})]);
  for (const d of limits) {
    const has = (r) => !!r.siteLimits && d in r.siteLimits;
    const a = has(cur) ? cur.siteLimits[d] : undefined, b = has(next) ? next.siteLimits[d] : undefined;
    if (a === b) continue;
    const target = "limit:" + d;
    if (b === undefined) out.push({ siteLimit: d, target, text: `${d}: limit removed` });
    else if (a === undefined) out.push({ siteLimit: d, target, text: `${d}: ${siteLimitText(b)}` });
    else if (a && b) out.push({ siteLimit: d, target, text: `${d}: ${a} → ${b} min a day` });
    else out.push({ siteLimit: d, target, text: `${d}: ${siteLimitText(a)} → ${siteLimitText(b)}` });
  }
  const sa = cur.study || [], sb = next.study || [];
  for (const d of sb) if (!sa.includes(d)) out.push({ study: d, target: "study:" + d, text: `${d}: a study site, open in exam mode` });
  for (const d of sa) if (!sb.includes(d)) out.push({ study: d, target: "study:" + d, text: `${d}: no longer a study site` });
  out.push(...describeVideoChanges(cur.videos || [], next.videos || []).map((c) => ({ ...c, target: "video:" + c.video })));
  if (cur.dayStart !== next.dayStart) out.push({ target: "dayStart", text: `The day starts at ${next.dayStart}:00` });
  const ea = cur.exam || null, eb = next.exam || null;
  if ((ea && ea.until) !== (eb && eb.until)) {
    const until = (x) => new Date(x.until).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
    out.push({ target: "exam", text: eb ? `Exam mode until ${until(eb)}` : "Exam mode ends" });
  }
  return out;
}

export function siteLimitText(m) {
  return m === null ? "closed only in exam mode" : minutesText(m);
}

export function minutesText(m) {
  return m === 0 ? "closed all day" : `${m} min a day`;
}

/**
 * Ask for new rules. What tightens applies now; what loosens waits until the next morning.
 * Asking again replaces what was waiting, so asking for the rules in force cancels it.
 * Returns { state, now: [changes applied], later: [changes waiting], from }.
 */
export function proposeRules(state, next, now, { source = "extension", undoable = false } = {}) {
  let s = rollover(state, now);
  // A rule set during the watch week (by chat or on the rules page) ends the week, so it applies as said.
  if (watching(s) && !same(cleanRules({ dayStart: s.rules.dayStart, ...next }, s.rules), s.rules)) s = endWatch(s, now);
  const t = s.clock.floor;
  const want = cleanRules({ dayStart: s.rules.dayStart, ...next }, s.rules);
  // Exam mode in force is never ended or shortened by a rule change; only endExam (the agent) does that.
  if (examOn(s) && (!want.exam || want.exam.until < s.rules.exam.until)) want.exam = s.rules.exam;
  // A stray tap on the rules page is undone for free (QA round 2, first-run H3): for a minute after a change
  // there, the rules from before it count as the rules in force, so going back to them applies now.
  const undo = undoable && s.undo && s.undo.until > t ? s.undo : null;
  // Only the rules that tightening changed may go back; everything else is judged against the rules in force.
  let applied = tighten(s.rules, want, s);
  if (undo && (undo.targets || []).length) {
    // Each rule goes back only if that loosens it: the way back never makes anything stricter than it is now.
    const back = tighten(undo.rules, want, s);
    for (const tg of undo.targets) {
      const cand = revertTargets(applied, back, [tg]);
      if (same(tighten(cand, applied, s), applied)) applied = cand;
    }
  }
  const nowChanges = describeChanges(s.rules, applied);
  const logged = (st, later = []) => (nowChanges.length || later.length
    ? { ...st, log: logEvent(st, "rules", { now: nowChanges.map((c) => c.text), later: later.map((c) => c.text), source }) } : st);
  const targets = nowChanges.map((c) => c.target).filter(Boolean);
  const tightened = undoable && nowChanges.length
    ? undo ? { ...undo, targets: [...new Set([...(undo.targets || []), ...targets])] } : { rules: s.rules, targets, until: t + UNDO_MS }
    : undo;
  const base0 = { ...s, rules: applied, undo: tightened || null };
  if (same(applied, want)) {
    return { state: logged(withoutLoosen({ ...base0, rules: want, pending: null }, "rules")), now: nowChanges, later: [], from: null, undo: !!tightened };
  }
  const from = s.usage.endsAt;
  const later = describeChanges(applied, want);
  // What the agent already approved (or, with Claude help off, the morning alone) stays approved (QA round 2, H1
  // and first-run H4): only what goes beyond it is asked about.
  const p = s.pending;
  const approvedRules = p ? (p.ok ? p.rules : p.approved || applied) : applied;
  const within = tighten(approvedRules, want, s);
  const keepApproved = same(within, applied) ? null : within; // the approved part, if it loosens anything
  if (same(within, want)) {
    return { state: logged(withoutLoosen({ ...base0, pending: { rules: want, from, key: loosenKey(later), ok: true } }, "rules"), later), now: nowChanges, later, from, needsOk: false };
  }
  let asked = describeChanges(within, want);
  // A no holds only the rule it was about until the morning (Maxime, 2026-10-18): Video's minutes after a no on
  // Video, not Games, not exam mode, not a study site. Those parts go back to what was approved; the rest is asked.
  const held = asked.filter((c) => c.target && ((s.denied || {})["t:" + c.target] || 0) > t);
  if (held.length && held.length < asked.length) {
    Object.assign(want, revertTargets(want, within, held.map((c) => c.target)));
    asked = describeChanges(within, want);
  }
  const key = loosenKey(asked);
  const approvedOnly = keepApproved ? { rules: keepApproved, from, key: loosenKey(describeChanges(applied, keepApproved)), ok: true } : null;
  // After a no, no other loosening of the rules is asked about until the morning (QA round 2, H3): not the
  // same sentence, not one minute more.
  if ((held.length && !asked.some((c) => !held.includes(c) && !(c.target && ((s.denied || {})["t:" + c.target] || 0) > t))) || ((s.denied || {})[key] || 0) > t) {
    return { state: logged(withoutLoosen({ ...base0, pending: approvedOnly }, "rules")), now: nowChanges, later: approvedOnly ? describeChanges(applied, keepApproved) : [], from: approvedOnly ? from : null, refused: "asked_today", denied: asked };
  }
  // With Claude help on, the agent holds the key: the loosening waits for its yes, then for the morning.
  // Claude help turned off today still needs it until the morning (turning it off is itself a loosening), and
  // nothing can ask it, so the loosening is refused. Help off since an earlier day: the morning alone.
  if (agentNeeded(s) && !consented(s, "talk")) {
    return { state: logged(withoutLoosen({ ...base0, pending: approvedOnly }, "rules")), now: nowChanges, later: approvedOnly ? describeChanges(applied, keepApproved) : [], from: approvedOnly ? from : null, refused: "help_off_today", denied: asked };
  }
  if (!agentNeeded(s)) {
    return { state: logged(withoutLoosen({ ...base0, pending: { rules: want, from, key, ok: true } }, "rules"), later), now: nowChanges, later, from, needsOk: false };
  }
  const pending = { rules: want, approved: keepApproved, from, key, ok: false };
  const queued = withLoosen({ ...base0, pending }, { kind: "rules", changes: asked.map((c) => c.text), targets: asked.map((c) => c.target).filter(Boolean), key, asked: "" });
  return { state: logged(queued, later), now: nowChanges, later, from, needsOk: true, asked };
}

/** `want` with these changes taken back to `base`: "kind:video", "site:x.io", "limit:x.io", "study:x.edu", "video:v1", "dayStart", "exam". */
function revertTargets(want, base, targets) {
  const r = structuredClone(want);
  const back = (field, key) => {
    r[field] = { ...(r[field] || {}) };
    if (base[field] && key in base[field]) r[field][key] = structuredClone(base[field][key]); else delete r[field][key];
  };
  for (const tg of targets) {
    const i = tg.indexOf(":"), what = i < 0 ? tg : tg.slice(0, i), key = i < 0 ? "" : tg.slice(i + 1);
    if (what === "kind") back("kinds", key);
    else if (what === "site") back("sites", key);
    else if (what === "limit") back("siteLimits", key);
    else if (what === "study") r.study = (base.study || []).includes(key) ? [...new Set([...(r.study || []), key])] : (r.study || []).filter((x) => x !== key);
    else if (what === "video") { const v = (base.videos || []).find((x) => x.id === key); r.videos = (r.videos || []).filter((x) => x.id !== key); if (v) r.videos.push(structuredClone(v)); }
    else if (what === "dayStart") r.dayStart = base.dayStart;
    else if (what === "exam") r.exam = base.exam;
  }
  return r;
}

/** Whether a loosening needs the agent: Claude help on, or turned off only today (it counts from the morning). */
export function agentNeeded(state) {
  if (consented(state, "talk")) return true;
  const off = state.helpOff;
  return !!off && off.until > ((state.clock && state.clock.floor) || 0);
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
  if (d.video) return { refused: "video_rule" }; // a video rule is changed on the rules page, not argued at the gate
  const cool = (s.cooldowns || {})[d.ladder] || 0;
  if (cool > t) return { refused: "cooldown", until: cool };
  if ((s.usage.passes[d.ladder] || 0) >= PASS_LADDER.length) return { refused: "passes_used" };
  if (!text) return { refused: "empty" };
  return {
    payload: {
      // A site with its own limit is sent as kind "site" (its minutes are its own, not a kind's).
      installId: s.installId, goal: s.goal || "", site: d.site || d.passDomain || siteDomain(url), kind: KINDS[d.kind] && !d.site ? d.kind : "site",
      minutesUsed: Math.min(d.usedMinutes || 0, 1440), budget: d.budgetMinutes ?? 0, deadlines: deadlines(s, t),
      // In exam mode the gate gives a pass only for a page that serves the exam (shared names, one-model step 1).
      exam: examForRelay(s), now: localIso(t),
      // The gate's own question, when this message answers it: with it the relay decides, allow or deny (tester case).
      ...(((s.followUps || {})[d.ladder] || 0) > t && (s.gateAsked || {})[d.ladder] ? { asked: s.gateAsked[d.ladder].q.slice(0, 300) } : {}),
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
  // The pass is for the site the gate is about; its ladder and cooldown are its kind's or its base domain's.
  const d = decide(s, { url, now: t });
  if (!d.ladder || !d.passDomain) return { state, result: { decision: "error" } };
  const e = { domain: d.passDomain, kind: d.ladder };
  const kind = e.kind;
  const { [kind]: _, ...followUps } = s.followUps || {};
  if (answer.decision === "allow") {
    const n = s.usage.passes[kind] || 0;
    const cap = Math.min(PASS_LADDER[Math.min(n, PASS_LADDER.length - 1)], examOn(s) ? EXAM_MAX_PASS_MINUTES : Infinity);
    const minutes = Math.max(1, Math.min(cap, Math.round(Number(answer.minutes) || 1)));
    s = {
      ...s, followUps,
      passes: { ...(s.passes || {}), [e.domain]: { kind, secondsLeft: minutes * 60 } },
      usage: { ...s.usage, passes: { ...s.usage.passes, [kind]: n + 1 } },
      cooldowns: { ...(s.cooldowns || {}), [kind]: t + minutes * 60e3 + AFTER_PASS_MS },
    };
    s = addTurn(s, "note", `The gate gave ${minutes} min on ${e.domain}.`, t);
    s = { ...s, log: logEvent(s, "pass", { site: e.domain, kind, minutes, exam: examOn(s) || undefined }) };
    return { state: s, result: { decision: "allow", minutes, site: e.domain, reply: answer.reply } };
  }
  if (answer.decision === "ask") {
    // One question; the answer to it is decided by the relay (it is sent the question as `asked`). Should a second
    // question come anyway, it is shown and answered once more, never turned into a no without a word; a third is a no.
    const n = ((s.followUps || {})[kind] > t && (s.gateAsked || {})[kind] ? s.gateAsked[kind].n : 0) + 1;
    if (n <= 2) {
      s = { ...s, followUps: { ...(s.followUps || {}), [kind]: t + FOLLOW_UP_MS }, gateAsked: { ...(s.gateAsked || {}), [kind]: { q: answer.reply.slice(0, 300), n } } };
      return { state: s, result: { decision: "ask", reply: answer.reply } };
    }
  }
  const until = t + COOLDOWN_MS;
  const { [kind]: _asked, ...gateAsked } = s.gateAsked || {};
  s = { ...s, followUps, gateAsked, cooldowns: { ...(s.cooldowns || {}), [kind]: until } };
  s = { ...s, log: logEvent(s, "gate.no", { site: e.domain, kind }) };
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
  const was = consented(state, "talk");
  let s = setConsent(state, "help", on);
  if (on) return { ...s, talk: true, sorting: !!sorting, unknown: sorting ? s.unknown || {} : {}, helpOff: null };
  for (const name of HELP_COVERS) s = setConsent(s, name, false);
  // Nothing is sent from now on. But the agent's key to loosening only goes at the next morning: until then a
  // loosening can't be asked, so it is refused (Maxime's rule: every loosening needs the agent's OK).
  const until = (state.usage && state.usage.endsAt) || 0;
  return { ...s, talk: false, sorting: false, unknown: {}, helpOff: was ? { until } : s.helpOff || null };
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
  // The last six turns of the one thread the engine keeps (history passed in is used only when there is none).
  const kept = ((s.thread && s.thread.turns) || []).filter((h) => h.role !== "note");
  const turns = (kept.length ? kept : Array.isArray(history) ? history : []).slice(-6)
    .filter((h) => h && (h.role === "user" || h.role === "gatekeeper") && typeof h.text === "string" && h.text.trim())
    .map((h) => ({ role: h.role, text: h.text.trim().slice(0, MAX_MESSAGE) }));
  return {
    payload: {
      installId: s.installId, message: text.slice(0, MAX_MESSAGE), history: turns,
      rules: rulesForChat(wantedRules(s)), today: dayKey(s.clock.floor, s.rules.dayStart),
      // Exam mode and the time of day, so "until Wednesday 8:30" and "end exam mode" can be understood.
      exam: examForRelay(s),
      now: localIso(s.clock.floor),
      // A no holds every loosening until the morning: the relay then drops loosening ops and says so (QA round 3, N1).
      // A no now holds only its own rule (2026-10-18), so loosening as a whole is never locked; the card says which.
      loosenLocked: false,
      // So "are you connected to my calendar?" gets a true answer (Maxime's re-test): the state only, as the
      // privacy policy's chat row (/privacy/0.2, 18 October) and What's sent say.
      ...(SEND_CALENDAR_STATUS ? { calendar: calendarStatus(s) } : {}),
    },
  };
}

/** Exam mode as the relay is sent it (shared names): until as local time with its offset, or null. */
function examForRelay(s) {
  return examOn(s) ? { until: localIso(s.rules.exam.until), goal: (s.rules.exam.goal || "").slice(0, 300) } : null;
}

/** "2026-10-17T14:05:00-04:00": local time with its offset. */
export function localIso(t) {
  const d = new Date(t);
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
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
  const { rules, skipped: skippedOps, needsAccess, examEnd } = applyDiff(wantedRules(s), question ? [] : answer.diff);
  const skipped = [...skippedOps];
  // An exam start must lie ahead and within MAX_EXAM_DAYS; anything else is left out of the card.
  const asked = rules.exam, had = wantedRules(s).exam;
  if (asked && asked !== had && (!had || asked.until !== had.until)) {
    if (asked.until <= s.clock.floor) { rules.exam = had || null; skipped.push({ op: "examStart" }); }
    else rules.exam = { ...asked, until: Math.min(asked.until, s.clock.floor + MAX_EXAM_DAYS * 86400e3) };
  }
  const r = proposeRules(s, rules, now, { undoable: true });
  // Only what this answer changes: a loosening already waiting for the morning is not shown again.
  const before = proposeRules(s, wantedRules(s), now, { undoable: true });
  const fresh = (list, old) => { const seen = new Set(old.map((c) => c.text)); return list.filter((c) => !seen.has(c.text)); };
  // A loosening the agent will be asked about is tagged so on the card ("asks you why"), not "tomorrow".
  const nowChanges = fresh(r.now, before.now), later = fresh(r.later, before.later).map((c) => ({ ...c, agent: !!r.needsOk }));
  // "End exam mode early" is shown on the card as a loosening for the agent, never as done.
  const end = examEnd && examOn(s) ? { text: "End exam mode early", agent: true } : null;
  return { reply, question, rules, now: nowChanges, later: end ? [...later, end] : later, from: later.length || end ? r.from : null, refused: r.refused,
    held: r.denied && r.denied.length ? r.denied.map((c) => c.text.split(":")[0]) : null,
    skipped: skipped.length, needsAccess, examEnd: !!end };
}

// ---------- exam mode ----------
// Until a set time, every kind is closed. Starting it or moving its end later is a tightening and applies at
// once; ending it early is a loosening the agent decides (see endExam).

export const MAX_EXAM_DAYS = 14;

export function examOn(state) {
  const e = state.rules && state.rules.exam;
  return !!e && e.until > strictNow(state);
}

/** Start exam mode, or move its end later (the later end wins). Applied through proposeRules: a tightening. */
export function startExam(state, { until, goal, source = "extension", at }, now) {
  const s = rollover(state, now);
  const t = s.clock.floor;
  const end = Math.min(Number(until), t + MAX_EXAM_DAYS * 86400e3);
  if (!Number.isFinite(end) || end <= t) return { state: s, refused: "bad_until" };
  const cur = examOn(s) ? s.rules.exam : null;
  // The exam's own time is fixed when exam mode starts (QA round 3, N1): the offered event's start, or the time
  // given, else its end. Nothing added to the calendar later can move it.
  const own = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.min(Number(at), end) : end;
  const exam = { until: Math.max(end, cur ? cur.until : 0), goal: String(goal || (cur && cur.goal) || "").replace(/\s+/g, " ").trim().slice(0, 200), from: cur && cur.from ? cur.from : t, at: cur && cur.at ? cur.at : own };
  const r = proposeRules(s, { ...wantedRules(s), exam }, now, { source });
  return { state: { ...r.state, log: logEvent(r.state, "exam.start", { until: exam.until, goal: exam.goal, source }) }, exam };
}

/** End exam mode now, but only with the sentence, word for word. */
/**
 * Ask to end exam mode early (decision of 2026-10-17, "agent decides, now if done"). It is a loosening: the
 * agent decides from the reason. A yes ends it at once if the exam is over, else the next morning. With
 * Claude help off it runs to its set end. If it ends before the next morning anyway, nothing is asked.
 */
export function endExam(state, now) {
  const s = rollover(state, typeof now === "object" ? now.now : now);
  if (!examOn(s)) return { state: s, refused: "not_on" };
  if (s.rules.exam.until <= s.usage.endsAt) return { state: s, refused: "ends_anyway", until: s.rules.exam.until };
  if (!consented(s, "talk")) return { state: s, refused: "help_off", until: s.rules.exam.until };
  const key = "exam:" + s.rules.exam.until;
  if (((s.denied || {})[key] || 0) > s.clock.floor || ((s.denied || {}).exam || 0) > s.clock.floor) return { state: s, refused: "asked_today" };
  return { state: withLoosen(s, { kind: "exam", changes: ["End exam mode early"], key, asked: "" }), needsOk: true };
}

/**
 * The exam's own time, if it has begun: the latest exam on the calendar link that started inside exam mode
 * and before now. Only then can the agent's yes end exam mode at once.
 */
export function examAt(state) {
  if (!examOn(state)) return null;
  const e = state.rules.exam;
  // The exam exam mode was started for, fixed then (QA round 3, N1): never a quiz added to the calendar since.
  const at = e.at || e.until;
  return at <= strictNow(state) ? at : null;
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

export const MAX_LOG = 300;

/**
 * One history log, kept on this device: rule changes, loosening asks and answers, passes and refusals at the
 * gate, and exam starts and ends, each with where it came from. Returns the new log.
 */
export function logEvent(s, type, entry = {}) {
  const at = (s.clock && s.clock.floor) || 0;
  return [...(s.log || []), { at, day: s.usage && s.usage.day, type, ...entry }].slice(-MAX_LOG);
}
const logLoosen = (s, entry) => logEvent(s, "loosen", entry);

// A second loosening waits behind the first instead of replacing it; one per kind ("rules", "exam").
function withLoosen(s, item) {
  const queue = (s.loosenQueue || []).filter((q) => q.kind !== item.kind);
  if (!s.loosen || s.loosen.kind === item.kind) return { ...s, loosen: item, loosenQueue: queue };
  return { ...s, loosenQueue: [...queue, item] };
}
function withoutLoosen(s, kind) {
  const queue = (s.loosenQueue || []).filter((q) => q.kind !== kind);
  if (s.loosen && s.loosen.kind === kind) return { ...s, loosen: queue[0] || null, loosenQueue: queue.slice(1) };
  return { ...s, loosenQueue: queue };
}

/** Cancel the loosening waiting for its reason. What the agent approved earlier still applies in the morning. */
export function dropLoosen(state, now) {
  let s = rollover(state, now);
  const l = s.loosen;
  if (!l) return s;
  if (l.kind === "rules") {
    const p = s.pending;
    const kept = p && p.approved ? { rules: p.approved, from: p.from, key: p.key, ok: true } : p && p.ok ? p : null;
    // A waiting change that is only the rules in force waits for nothing.
    s = { ...s, pending: kept && describeChanges(s.rules, kept.rules).length ? kept : null };
  }
  s = addTurn(withoutLoosen(s, l.kind), "note", l.kind === "exam" ? "Exam mode stays on." : "That change is dropped; nothing loosens.", now);
  return { ...s, log: logLoosen(s, { kind: l.kind, changes: l.changes, decision: "dropped" }) };
}

/** What the agent is sent for one reason, or why nothing is sent. */
export function loosenRequest(state, { message, now }) {
  const s = rollover(state, now);
  const l = s.loosen;
  const text = String(message || "").trim();
  if (!l) return { refused: "nothing_waiting" };
  if (!consented(s, "talk")) return { refused: "no_consent" };
  if (!text) return { refused: "empty" };
  const at = examAt(s);
  // examAt (shared names, QA round 2 C3): the exam's own time if it has begun, else null; "now" needs it.
  const exam = examForRelay(s) && { ...examForRelay(s), examAt: at ? localIso(at) : null };
  return { payload: { installId: s.installId, kind: l.kind, goal: s.goal || "", changes: l.changes, asked: l.asked || "", message: text.slice(0, MAX_MESSAGE),
    exam, now: localIso(s.clock.floor) } };
}

/** Apply the agent's answer. Anything malformed changes nothing: the loosening keeps waiting for a yes. */
export function applyLoosenAnswer(state, { answer, message = "", now }) {
  const ok = answer && ["allow", "deny", "ask"].includes(answer.decision) && typeof answer.reply === "string";
  let s = rollover(state, now);
  const l = s.loosen;
  if (!ok || !l) return { state, result: { decision: "error" } };
  const log = (decision) => logLoosen(s, { kind: l.kind, changes: l.changes, message: String(message).slice(0, MAX_MESSAGE), decision, reply: answer.reply.slice(0, 280) });
  if (message) s = addTurn(s, "user", message, now);
  s = addTurn(s, "gatekeeper", answer.reply, now);
  if (answer.decision === "ask" && !l.asked) {
    return { state: { ...s, loosen: { ...l, asked: answer.reply.slice(0, 300) }, log: log("ask") }, result: { decision: "ask", reply: answer.reply } };
  }
  if (answer.decision === "allow") {
    const morning = s.usage.endsAt;
    // For exam mode: at once if the agent says the exam is over (when: "now"), else the next morning. A relay
    // without the field (when missing) means the morning.
    // "Now" is a rule, not a judgement (QA round 2, C3): only once the exam on the calendar has begun.
    const said = answer.when === "now" || answer.examDone === true;
    const at = l.kind === "exam" && said && examAt(s) ? s.clock.floor : morning;
    // A study site asked for during exam mode opens at once on a yes: it is needed now, and only for studying.
    const studyNow = l.kind === "rules" && examOn(s) && (l.targets || []).length && l.targets.every((tg) => tg.startsWith("study:")) && s.pending;
    s = l.kind === "exam" ? examEnd(s, at)
      : studyNow ? { ...s, rules: { ...s.rules, study: [...new Set([...(s.rules.study || []), ...l.targets.map((tg) => tg.slice(6))])] }, pending: null }
      : { ...s, pending: s.pending ? { ...s.pending, ok: true, approved: null, from: Math.max(s.pending.from, morning) } : null };
    s = { ...withoutLoosen(s, l.kind), log: log("allow") };
    if (l.kind === "exam") s = { ...s, log: logEvent(s, "exam.end", { how: at === s.clock.floor ? "agent, at once" : "agent, next morning", at: at }) };
    return { state: s, result: { decision: "allow", reply: answer.reply, from: at, now: at === s.clock.floor } };
  }
  // No (or a second question): the rule stays, and the same request waits until tomorrow.
  // What the agent approved earlier still applies in the morning; only what it was asked now is refused.
  const p = s.pending;
  const kept = l.kind === "rules" ? (p && p.approved ? { rules: p.approved, from: p.from, key: p.key, ok: true } : null) : p;
  // The no holds what it was about until the morning: each of the request's rules, or ending exam mode.
  const held = Object.fromEntries((l.kind === "exam" ? ["exam"] : (l.targets || [])).map((tg) => [l.kind === "exam" ? "exam" : "t:" + tg, s.usage.endsAt]));
  s = { ...withoutLoosen({ ...s, pending: kept, denied: { ...(s.denied || {}), [l.key]: s.usage.endsAt, ...held } }, l.kind), log: log("deny") };
  return { state: s, result: { decision: "deny", reply: answer.reply, until: s.usage.endsAt } };
}

/**
 * The agent could not be reached (offline, the relay or Anthropic down, the day's cap): nothing loosens
 * (QA round 2, H2). The request keeps waiting, unapproved, and can be asked again later.
 */
export function loosenUnavailable(state, { message = "", error = "", now }) {
  let s = rollover(state, now);
  const l = s.loosen;
  if (!l) return { state };
  if (message) s = addTurn(s, "user", message, now);
  const capped = error === "daily_limit";
  s = addTurn(s, "note", (capped ? "Gatekeeper has answered enough for today" : "Gatekeeper couldn't be reached") +
    (l.kind === "exam" ? ", so exam mode stays on. Ask again later." : ", so nothing changes yet. Your change keeps waiting; ask again later."), now);
  return { state: { ...s, log: logLoosen(s, { kind: l.kind, changes: l.changes, message: String(message).slice(0, MAX_MESSAGE), decision: "unavailable", reply: String(error).slice(0, 80) }) } };
}

// ---------- the Mac app (native messaging, contract version 1 in ~/gatekeeper-mac/docs/contract.md) ----------

export const MAC_PAGES = { today: "pages/popup.html", rules: "pages/rules.html", talk: "pages/talk.html", week: "pages/week.html", exam: "pages/rules.html#exam" };

/**
 * Today, for Gatekeeper for Mac: todaySummary() as is (each watched kind with what the engine decided:
 * left, status, fraction), plus who sent it, the pages, and exam mode. The Mac shows status as sent.
 */
export function snapshot(state, now, { extensionId, base } = {}) {
  const s = rollover(state, now);
  const today = todaySummary(s, now);
  return {
    // base: the extension's own address ("safari-web-extension://<uuid>/" in Safari), which pages are relative to.
    ...today, type: "snapshot", v: 1, at: s.clock.floor, extensionId, base, pages: MAC_PAGES,
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
  if (req.type === "exam.start") return startExam(state, { until: req.until, goal: req.goal, source: "mac" }, now);
  return { state, refused: "unknown_type" };
}

// ---------- the one thread ----------
// One conversation with Gatekeeper, kept by the engine on this device: the popup, the Talk tab and the tab the
// Mac app opens all show it. It holds the last MAX_TURNS turns and the open card (the change waiting for Apply).
// Gate outcomes and the agent's answers on loosening show in it as lines.

export const MAX_TURNS = 50;

export function addTurn(state, role, text, now) {
  const t = Math.max(Number(now) || 0, (state.clock && state.clock.floor) || 0);
  const th = state.thread || { turns: [], card: null };
  const turn = { role, text: String(text || "").slice(0, 600), at: t };
  return { ...state, thread: { ...th, turns: [...(th.turns || []), turn].slice(-MAX_TURNS) } };
}

/** The relay's answer to a chat message: its reply (or question) as a turn, and a card if it changes anything. */
export function recordChatAnswer(state, answer, preview, now) {
  let s = addTurn(state, "gatekeeper", preview.question || preview.reply || "", now);
  const changes = !preview.question && (preview.now.length || preview.later.length);
  const card = changes ? {
    answer: { reply: answer.reply || "", question: null, diff: Array.isArray(answer.diff) ? answer.diff.slice(0, 10) : [] },
    view: { now: preview.now.map((c) => c.text), later: preview.later.map((c) => ({ text: c.text, agent: !!c.agent })), from: preview.from, needsAccess: preview.needsAccess, skipped: preview.skipped },
    at: s.clock ? s.clock.floor : now,
  } : null;
  // After a no today, the reply says why nothing loosens; the generic line would contradict it (QA round 3, chat N1).
  const locked = preview.refused === "asked_today";
  if (!preview.question && !changes && !locked) s = addTurn(s, "gatekeeper", "That changes nothing in your rules.", now);
  if (locked && !changes) s = addTurn(s, "gatekeeper", `I said no to loosening ${preview.held ? preview.held.join(", ") : "that"} today, so it stays as it is. You can ask again after ${(s.rules && s.rules.dayStart) ?? 4}:00.`, now);
  return { ...s, thread: { ...s.thread, card } };
}

const hhmm = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * Apply the open card, checked again against the rules as they are now (a card from an hour ago cannot
 * apply something stale). Returns what happened, and says it in the thread.
 */
export function applyCard(state, now) {
  let s = rollover(state, now);
  const card = s.thread && s.thread.card;
  if (!card) return { state: s, refused: "no_card" };
  const p = chatPreview(s, card.answer, now);
  if (p.error) return { state: s, refused: p.error };
  const r = proposeRules(s, p.rules, now, { source: "talk", undoable: true });
  s = r.state;
  let text;
  let exam = null;
  if (p.examEnd) {
    exam = endExam(s, now);
    s = exam.state;
    text = exam.needsOk ? "To end exam mode early, tell me why. Once your exam's time has come, it can end now; before that, tomorrow morning at the earliest."
      : { ends_anyway: `Exam mode ends at ${hhmm(exam.until)} anyway.`, help_off: `With AI help off, exam mode runs to its end at ${hhmm(exam.until)}.`,
          asked_today: "I said no to ending it today. You can ask again tomorrow.", not_on: "Exam mode is already off." }[exam.refused] || "Nothing changed.";
  } else if (r.refused === "asked_today") text = `I said no to a loosening today${r.now.length ? "; the stricter part applies now" : ""}. You can ask again tomorrow.`;
  else if (r.refused === "help_off_today") text = `AI help was turned off today, so nothing loosens until tomorrow${r.now.length ? "; the stricter part applies now" : ""}.`;
  else if (r.needsOk) text = `${r.now.length ? "The stricter part applies now. " : ""}To loosen the rest, tell me why: what changed?`;
  else if (r.later.length) text = `Done. ${r.now.length ? "Some of it applies now; the rest " : "It "}applies tomorrow at ${hhmm(r.from)}.`;
  else text = "Done. It applies now.";
  s = addTurn({ ...s, thread: { ...s.thread, card: null } }, "gatekeeper", text, now);
  return { state: s, outcome: { now: r.now, later: r.later, from: r.from, needsOk: !!r.needsOk || !!(exam && exam.needsOk), refused: r.refused, exam: exam && { refused: exam.refused, needsOk: !!exam.needsOk } } };
}

/** "Not this": the card goes, nothing changes. */
export function dropCard(state, now) {
  if (!state.thread || !state.thread.card) return state;
  return addTurn({ ...state, thread: { ...state.thread, card: null } }, "gatekeeper", "Nothing changed.", now);
}

/** "Forget this talk": the thread and its card are cleared. */
export function forgetThread(state) {
  return { ...state, thread: { turns: [], card: null } };
}

// ---------- the calendar ----------
// A calendar link the user pastes once, read on this device once a day (the hands fetch it). Its events give
// the exam offer on Today and the Mac, and the gate's deadlines. The link and the events never leave the
// device, except the next few events' titles and dates, sent to the gate with a message (Claude help).

export const CALENDAR_EVERY_MS = 24 * 3600e3;
export const OFFER_AHEAD_MS = 48 * 3600e3;

export function setCalendar(state, raw) {
  if (raw === null || raw === "") return { state: { ...state, calendar: null } };
  const problem = calendarProblem(raw);
  if (problem) return { state, refused: problem };
  const url = calendarUrl(raw);
  if (!url) return { state, refused: "bad_url" };
  return { state: { ...state, calendar: { url, events: [], fetchedAt: 0, error: null } }, url };
}

/** Whether the calendar should be read again now. */
export function calendarDue(state, now) {
  const c = state.calendar;
  return !!c && Math.max(now, (state.clock && state.clock.floor) || 0) - (c.fetchedAt || 0) >= CALENDAR_EVERY_MS;
}

/** The feed's text, read by the hands: keep the events of the next 14 days. */
export function recordCalendar(state, text, now) {
  const c = state.calendar;
  if (!c) return state;
  // A web page (a share link, a sign-in page) is not a feed: it is said, never read as "no events".
  if (!isIcs(text)) return calendarFailed(state, "not_ical", now);
  const t = Math.max(now, (state.clock && state.clock.floor) || 0);
  const events = parseIcs(text).filter((e) => e.start >= t - 3600e3 && e.start <= t + 14 * 86400e3).slice(0, 50).map(({ title, start }) => ({ title, start }));
  return { ...state, calendar: { ...c, events, fetchedAt: t, readAt: t, error: null } };
}

export function calendarFailed(state, error, now) {
  const c = state.calendar;
  if (!c) return state;
  const t = Math.max(now, (state.clock && state.clock.floor) || 0);
  return { ...state, calendar: { ...c, fetchedAt: t, error: String(error).slice(0, 80) } };
}

/** Send the calendar's state to the chat: on since /privacy/0.2's chat row says "whether you connected a calendar". */
export const SEND_CALENDAR_STATUS = true;

/**
 * The calendar's state for the chat (/rules, the relay's names): connected, failed or none, and when it was last read
 * fine. Never the link, never an event.
 */
export function calendarStatus(state) {
  const c = state.calendar;
  if (!c) return { status: "none", readAt: null };
  const okAt = c.readAt || (!c.error && c.fetchedAt) || 0;
  return { status: c.error || !c.fetchedAt ? "failed" : "connected", readAt: okAt ? localIso(okAt) : null };
}

/** The next deadlines for the gate: up to five, title and date. */
export function deadlines(state, t) {
  const c = state.calendar;
  if (!c) return [];
  return c.events.filter((e) => e.start >= t).slice(0, 5).map((e) => ({ title: e.title, due: localIso(e.start).slice(0, 10) }));
}

/** "Midterm 15.425, Wed 8:30. Start exam mode until then?": an exam in the next 48 hours, offered once. */
export function examOffer(state, now) {
  const s = rollover(state, now);
  const c = s.calendar;
  if (!c || examOn(s)) return null;
  const t = s.clock.floor;
  const dismissed = new Set(s.offersDismissed || []);
  const e = c.events.find((x) => x.start > t && x.start - t <= OFFER_AHEAD_MS && EXAM_WORDS.test(x.title) && !dismissed.has(x.title + "@" + x.start));
  return e ? { title: e.title, start: e.start } : null;
}

/** "Not now" on the offer: it is not shown again for that event. */
export function dismissOffer(state, offer) {
  if (!offer) return state;
  return { ...state, offersDismissed: [...(state.offersDismissed || []), offer.title + "@" + offer.start].slice(-50) };
}
