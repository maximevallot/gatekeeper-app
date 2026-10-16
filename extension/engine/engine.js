// The engine: rules, budgets, today's usage, and the decision for a page. Every function takes the
// state and returns a new one; nothing here touches a browser, the clock or storage, so the same code
// can later run on a server for every device. The hands (the extension today, a Mac helper and an
// iPhone app later) only report what is in front and enforce what the engine says.
//
// Rules are kinds of sites plus budgets: { kinds: { games: { minutes: 15 } }, sites: { "x.io": "games" } }.
// A kind absent from `kinds` is not watched. 0 minutes means always closed.
// Tightening a rule applies at once; loosening it waits until the next morning (dayStart, local time).
//
// Milestone 2 adds the gate that talks back and the sorting of unknown sites. The engine builds what is
// sent and applies what comes back (a pass, a cooldown, a site's kind); the hands make the network call.
// Nothing is sent unless the user said yes: `talk` for the gate, `sorting` for unknown sites.

import { KINDS, catalogKind, hostOf, matches } from "./catalog.js";

export const DEFAULT_MINUTES = 15;
export const DEFAULT_DAY_START = 4; // the day, and every budget, turns over at 4:00
export const MAX_TICK_SECONDS = 5; // one report never counts more than this, so a sleeping laptop costs nothing
export const SORT_AFTER_SECONDS = 60; // an unknown site is sorted once it has been in front this long
export const SORT_RETRY_MS = 3600e3; // after a failed sort, wait an hour before asking again
export const MAX_PASS_MINUTES = 10; // the relay clamps a pass to this too
export const COOLDOWN_MS = 10 * 60e3; // after a no, the gate does not listen again for this long
export const MAX_MESSAGE = 500;

export function initialState() {
  return {
    version: 1,
    setupDone: false,
    goal: "",
    rules: { kinds: {}, sites: {}, dayStart: DEFAULT_DAY_START },
    pending: null, // { rules, from }: a looser version waiting for the morning
    usage: { day: null, seconds: {} },
    installId: null, // a random UUID the hands make on first run; the relay counts its daily cap by it
    talk: false, // the user said yes to sending a gate message to the relay
    sorting: false, // the user said yes to sorting sites the catalog does not know
    sorted: {}, // domain -> kind, as the relay sorted it
    unknown: {}, // domain -> { seconds, asking, retryAt }: unknown sites in front today
    passes: {}, // kind -> until (ms): a pass the gate granted
    cooldowns: {}, // kind -> until (ms): the gate said no
  };
}

/** A state saved by an older version, with every field this one expects. */
export function upgrade(state) {
  return state ? { ...initialState(), ...state } : initialState();
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

function longestMatch(host, table) {
  let best = null;
  for (const [domain, kind] of Object.entries(table || {})) {
    if (matches(host, domain) && (!best || domain.length > best.domain.length)) best = { domain, kind };
  }
  return best ? best.kind : null;
}

/** The user's own sites first, then the catalog, then what the relay sorted. */
export function kindOf(state, url) {
  const host = hostOf(url);
  if (!host) return null;
  return longestMatch(host, state.rules.sites) || catalogKind(host) || longestMatch(host, state.sorted);
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

// A new day resets usage, and a loosening that was waiting for this morning applies.
export function rollover(state, now) {
  let s = state;
  if (s.pending && now >= s.pending.from) s = { ...s, rules: s.pending.rules, pending: null };
  const day = dayKey(now, s.rules.dayStart);
  if (s.usage.day !== day) s = { ...s, usage: { day, seconds: {} }, unknown: {} };
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
  const passUntil = (s.passes || {})[kind] || 0;
  const budget = rule.minutes * 60;
  const used = usedSeconds(s, kind, now);
  const base = {
    kind, label: label(kind), watched: true, title,
    usedMinutes: Math.floor(used / 60), budgetMinutes: rule.minutes,
    leftMinutes: Math.max(0, Math.ceil((budget - used) / 60)),
    reopensAt: nextDayStart(now, s.rules.dayStart),
  };
  if (passUntil > now) {
    return { ...base, verdict: "allow", pass: true, passUntil, leftMinutes: Math.ceil((passUntil - now) / 60e3) };
  }
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
  // A site nobody has sorted: once it has been in front for a minute, ask the relay once.
  let sort = null;
  const domain = siteDomain(url);
  if (before.kind === null && s.sorting && focused && active && domain) {
    const e = (s.unknown || {})[domain] || { seconds: 0 };
    const next = { ...e, seconds: e.seconds + Math.max(0, Math.min(seconds, MAX_TICK_SECONDS)) };
    const asking = e.asking && now - e.asking < 120e3; // a call in flight; a lost one is retried after 2 minutes
    if (next.seconds >= SORT_AFTER_SECONDS && !asking && !(e.retryAt > now)) {
      next.asking = now;
      sort = domain;
    }
    s = { ...s, unknown: { ...(s.unknown || {}), [domain]: next } };
  }
  return { state: s, decision: decide(s, { url, title, now }), sort };
}

/** The relay's answer for a domain. From now on it counts against that kind, if the kind is watched. */
export function recordSort(state, domain, kind) {
  const { [domain]: _, ...unknown } = state.unknown || {};
  return { ...state, sorted: { ...(state.sorted || {}), [domain]: kind }, unknown };
}

export function sortFailed(state, domain, now) {
  const e = (state.unknown || {})[domain] || { seconds: 0 };
  return { ...state, unknown: { ...(state.unknown || {}), [domain]: { ...e, asking: null, retryAt: now + SORT_RETRY_MS } } };
}

/** Kinds closed right now, and every domain the hands should stop before it loads. */
export function closedKinds(state, now) {
  const s = rollover(state, now);
  return Object.keys(s.rules.kinds)
    .filter((k) => !(((s.passes || {})[k] || 0) > now))
    .filter((k) => s.rules.kinds[k].minutes === 0 || usedSeconds(s, k, now) >= s.rules.kinds[k].minutes * 60);
}

export function closedDomains(state, now) {
  const s = rollover(state, now);
  const closed = new Set(closedKinds(s, now));
  const out = [];
  for (const k of closed) if (KINDS[k]) out.push(...KINDS[k].domains);
  for (const [domain, kind] of Object.entries(s.rules.sites || {})) if (closed.has(kind)) out.push(domain);
  for (const [domain, kind] of Object.entries(s.sorted || {})) if (closed.has(kind)) out.push(domain);
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

// ---------- the gate that talks back ----------

/**
 * What the gate sends to the relay for one message, or why it sends nothing. Only what the relay's
 * /gate needs: the site's domain, its kind, today's minutes and budget, the goal, and the message.
 */
export function gateRequest(state, { url, message, now }) {
  const s = rollover(state, now);
  const d = decide(s, { url, now });
  const text = String(message || "").trim();
  if (!s.talk) return { refused: "no_consent" };
  if (d.verdict === "allow") return { refused: "open" };
  const cool = (s.cooldowns || {})[d.kind] || 0;
  if (cool > now) return { refused: "cooldown", until: cool };
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
 * Apply the relay's answer. allow: a pass of that many minutes for the whole kind. deny, or a question
 * after the one follow-up is spent: the gate stays shut for COOLDOWN_MS. Anything malformed fails closed.
 */
export function applyGateAnswer(state, { kind, answer, lastTurn, now }) {
  const ok = answer && ["allow", "deny", "ask"].includes(answer.decision) && typeof answer.reply === "string";
  if (!ok) return { state, result: { decision: "error" } };
  if (answer.decision === "allow") {
    const minutes = Math.max(1, Math.min(MAX_PASS_MINUTES, Math.round(Number(answer.minutes) || 1)));
    const until = now + minutes * 60e3;
    return { state: { ...state, passes: { ...(state.passes || {}), [kind]: until } },
             result: { decision: "allow", minutes, until, reply: answer.reply } };
  }
  if (answer.decision === "ask" && !lastTurn) return { state, result: { decision: "ask", reply: answer.reply } };
  const until = now + COOLDOWN_MS;
  return { state: { ...state, cooldowns: { ...(state.cooldowns || {}), [kind]: until } },
           result: { decision: "deny", until, reply: answer.reply } };
}

export function setTalk(state, on) {
  return { ...state, talk: !!on };
}

export function setSorting(state, on) {
  return { ...state, sorting: !!on, unknown: on ? state.unknown || {} : {} };
}
