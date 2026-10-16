// The engine: rules, budgets, today's usage, and the decision for a page. Every function takes the
// state and returns a new one; nothing here touches a browser, the clock or storage, so the same code
// can later run on a server for every device. The hands (the extension today, a Mac helper and an
// iPhone app later) only report what is in front and enforce what the engine says.
//
// Rules are kinds of sites plus budgets: { kinds: { games: { minutes: 15 } }, sites: { "x.io": "games" } }.
// A kind absent from `kinds` is not watched. 0 minutes means always closed.
// Tightening a rule applies at once; loosening it waits until the next morning (dayStart, local time).

import { KINDS, catalogKind, hostOf, matches } from "./catalog.js";

export const DEFAULT_MINUTES = 15;
export const DEFAULT_DAY_START = 4; // the day, and every budget, turns over at 4:00
export const MAX_TICK_SECONDS = 5; // one report never counts more than this, so a sleeping laptop costs nothing

export function initialState() {
  return {
    version: 1,
    setupDone: false,
    goal: "",
    rules: { kinds: {}, sites: {}, dayStart: DEFAULT_DAY_START },
    pending: null, // { rules, from }: a looser version waiting for the morning
    usage: { day: null, seconds: {} },
  };
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

// ---------- sorting sites ----------

export function kindOf(state, url) {
  const host = hostOf(url);
  if (!host) return null;
  let best = null;
  for (const [domain, kind] of Object.entries(state.rules.sites || {})) {
    if (matches(host, domain) && (!best || domain.length > best.domain.length)) best = { domain, kind };
  }
  return best ? best.kind : catalogKind(host);
}

export function label(kind) {
  return (KINDS[kind] && KINDS[kind].label) || kind;
}

// ---------- the day ----------

// A new day resets usage, and a loosening that was waiting for this morning applies.
export function rollover(state, now) {
  let s = state;
  if (s.pending && now >= s.pending.from) s = { ...s, rules: s.pending.rules, pending: null };
  const day = dayKey(now, s.rules.dayStart);
  if (s.usage.day !== day) s = { ...s, usage: { day, seconds: {} } };
  return s;
}

function usedSeconds(state, kind, now) {
  return state.usage.day === dayKey(now, state.rules.dayStart) ? state.usage.seconds[kind] || 0 : 0;
}

// ---------- the decision ----------

/**
 * What to do with a page. `title` is unused in milestone 1; milestone 2's gate reads it.
 * verdict: "allow" (not watched, or time left), "gate" (today's budget is spent), "block" (0 minutes).
 */
export function decide(state, { url, title = "", now }) {
  const s = rollover(state, now);
  const kind = kindOf(s, url);
  const rule = kind && s.rules.kinds[kind];
  if (!rule) return { verdict: "allow", kind, watched: false };
  const budget = rule.minutes * 60;
  const used = usedSeconds(s, kind, now);
  const base = {
    kind, label: label(kind), watched: true, title,
    usedMinutes: Math.floor(used / 60), budgetMinutes: rule.minutes,
    leftMinutes: Math.max(0, Math.ceil((budget - used) / 60)),
    reopensAt: nextDayStart(now, s.rules.dayStart),
  };
  if (rule.minutes === 0) return { ...base, verdict: "block" };
  if (used >= budget) return { ...base, verdict: "gate" };
  return { ...base, verdict: "allow" };
}

/**
 * The hands report the page in front every few seconds. Time counts against the page's kind only while
 * its tab and window are focused and the user is active.
 */
export function tick(state, { url, title = "", focused, active, seconds, now }) {
  let s = rollover(state, now);
  const before = decide(s, { url, title, now });
  if (focused && active && before.watched && before.verdict === "allow") {
    const add = Math.max(0, Math.min(seconds, MAX_TICK_SECONDS));
    const kind = before.kind;
    s = { ...s, usage: { ...s.usage, seconds: { ...s.usage.seconds, [kind]: (s.usage.seconds[kind] || 0) + add } } };
  }
  return { state: s, decision: decide(s, { url, title, now }) };
}

/** Kinds closed right now, and every domain the hands should stop before it loads. */
export function closedKinds(state, now) {
  const s = rollover(state, now);
  return Object.keys(s.rules.kinds).filter((k) => s.rules.kinds[k].minutes === 0 || usedSeconds(s, k, now) >= s.rules.kinds[k].minutes * 60);
}

export function closedDomains(state, now) {
  const s = rollover(state, now);
  const closed = new Set(closedKinds(s, now));
  const out = [];
  for (const k of closed) if (KINDS[k]) out.push(...KINDS[k].domains);
  for (const [domain, kind] of Object.entries(s.rules.sites || {})) if (closed.has(kind)) out.push(domain);
  // A site the user moved out of a closed kind must not be caught by the catalog entry.
  return [...new Set(out)].filter((d) => closed.has(kindOf(s, "https://" + d + "/")));
}

// ---------- changing the rules ----------

/** The stricter of two rule sets, rule by rule. */
export function tighten(cur, next) {
  const kinds = {};
  for (const k of new Set([...Object.keys(cur.kinds), ...Object.keys(next.kinds)])) {
    const a = cur.kinds[k], b = next.kinds[k];
    kinds[k] = a && b ? { ...b, minutes: Math.min(a.minutes, b.minutes) } : a || b; // a kind dropped waits
  }
  const sites = { ...next.sites, ...cur.sites }; // adding a site applies now; removing or moving one waits
  return { ...next, kinds, sites, dayStart: cur.dayStart };
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
  if (cur.dayStart !== next.dayStart) out.push({ text: `The day starts at ${next.dayStart}:00` });
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
  const want = { kinds: {}, sites: {}, dayStart: s.rules.dayStart, ...next };
  const applied = tighten(s.rules, want);
  const nowChanges = describeChanges(s.rules, applied);
  if (same(applied, want)) {
    return { state: { ...s, rules: want, pending: null }, now: nowChanges, later: [], from: null };
  }
  const from = nextDayStart(now, s.rules.dayStart);
  return {
    state: { ...s, rules: applied, pending: { rules: want, from } },
    now: nowChanges, later: describeChanges(applied, want), from,
  };
}

/** The welcome tab's answers. The first rules only add limits, so they all apply at once. */
export function completeSetup(state, { kinds, goal }, now) {
  const rules = { ...state.rules, kinds: {} };
  for (const [k, m] of Object.entries(kinds)) rules.kinds[k] = { minutes: clampMinutes(m) };
  const r = proposeRules(state, rules, now);
  return { ...r, state: { ...r.state, goal: String(goal || "").trim().slice(0, 300), setupDone: true } };
}

export function setGoal(state, goal) {
  return { ...state, goal: String(goal || "").trim().slice(0, 300) };
}

export function clampMinutes(m) {
  const n = Math.round(Number(m));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 24 * 60) : DEFAULT_MINUTES;
}
