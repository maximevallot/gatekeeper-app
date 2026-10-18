// One Gatekeeper per person (design approved 2026-10-18, ~/brain/outputs/html/2026-10-17-gatekeeper-one-per-person.html).
// The account on the relay holds the one true state and runs this same engine; each device keeps a copy, decides
// pages from it, and sends what happened: spans of time and operations. Part of the engine: no browser APIs, so
// the relay's account object imports these files unchanged.
//
// - copyFor(account): what a device gets back, without what only the account keeps.
// - rebase(local, copy, { spans, ops }): a fresh copy, with this device's own fields and what it has not sent yet.
// - applyOp(state, op, now): one operation, the same function on the device (offline, at once) and on the account.
// - join(account, local, choice, now): two Gatekeepers meet; the account's rules stay whole.
// - leaveCopy(account): the full copy a device keeps when it leaves.

import * as engine from "./engine.js";

// The account contract, version 1 (~/gatekeeper-relay docs/account-contract.md on its account branch).
export const CONTRACT = 1;

/**
 * Fields that belong to one device, never to the account (contract, "The copy"): its clock, its calendar link,
 * work in flight, whether this browser may see every site, which of its sites it can't see, and offers it
 * dismissed. The install number is the account's ID once joined, so the account's daily allowance counts.
 */
export const DEVICE_FIELDS = ["clock", "calendar", "unknown", "judging", "sorting", "withheld", "offersDismissed"];

/** Requests a device applies to its own copy at once, and the account applies on sync. Claude's are online only. */
export const LOCAL_OPS = ["setup", "propose", "goal", "consent", "applyCard", "dropCard", "forgetThread", "startExam", "endExam",
  "dropLoosen", "watch", "endWatch", "watchShown", "dismissOffer", "noteGate", "sorted", "judged"];
export const ONLINE_OPS = ["talk", "chat", "loosen"];

const without = (s, keys) => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)));

/** What a device gets: the whole state but the account's clock and anything that belongs to one device. */
export function copyFor(account) {
  return structuredClone(without(account, DEVICE_FIELDS));
}

/**
 * A fresh copy from the account, with this device's own fields kept, and what it did since its last sync
 * (spans not acknowledged yet, operations not acknowledged yet) applied again on top, so nothing is lost or
 * counted twice.
 */
export function rebase(local, copy, { spans = [], ops = [], now } = {}) {
  const mine = Object.fromEntries(DEVICE_FIELDS.filter((k) => k in local).map((k) => [k, local[k]]));
  let s = engine.upgrade({ ...structuredClone(copy), ...mine });
  const t = now === undefined ? (s.clock && s.clock.floor) || 0 : now;
  s = engine.applySpans(s, spans, { now: t });
  for (const op of ops) s = applyOp(s, op, t).state;
  return s;
}

/**
 * One operation from a device, through the engine function the page handler calls today. Unknown and online-only
 * operations are refused here: the account runs those itself, with Claude.
 */
export function applyOp(state, op, now) {
  const o = op && typeof op === "object" ? op : {};
  switch (o.type || o.op) {
    case "propose": {
      const r = engine.proposeRules(state, o.rules || {}, now, { source: o.source || "extension", undoable: !!o.undoable });
      return { ...r, state: o.goal === undefined ? r.state : engine.setGoal(r.state, o.goal) };
    }
    case "goal": return { state: engine.setGoal(state, o.goal) };
    case "startExam": return engine.startExam(state, { until: o.until, goal: o.goal, source: o.source || "extension" }, now);
    case "endExam": return engine.endExam(state, now);
    case "setup": return engine.completeSetup(state, { kinds: o.kinds || {}, goal: o.goal }, now);
    case "watch": return { state: engine.startWatch(state, { goal: o.goal }, now) };
    case "endWatch": return { state: engine.endWatch(state, now) };
    case "watchShown": return { state: engine.markWatchShown(state) };
    case "dismissOffer": return { state: engine.dismissOffer(state, o.offer) };
    case "applyCard": return engine.applyCard(state, now);
    case "dropCard": return { state: engine.dropCard(state, now) };
    case "forgetThread": return { state: engine.forgetThread(state) };
    case "dropLoosen": return { state: engine.dropLoosen(state, now) };
    case "consent": return { state: o.help === undefined ? state : engine.setHelp(state, !!o.help, { sorting: !!(o.seeAll ?? o.sorting) }) };
    case "noteGate": return { state: engine.noteGate(state, now) };
    case "sorted": return { state: engine.recordSort(state, String(o.domain || ""), String(o.kind || "")) };
    case "judged": return { state: engine.recordJudgment(state, o.key, o.rule ?? null, o.by || "words", now) };
    default: return { state, refused: ONLINE_OPS.includes(o.type || o.op) ? "online_only" : "unknown_op" };
  }
}

/** The account made from the first device's state, when its welcome page is finished. */
export function createAccount(local, now) {
  return engine.rollover(engine.upgrade(copyFor(local)), now);
}

const byAt = (a, b) => (a.at || 0) - (b.at || 0);

/**
 * Two Gatekeepers meet (design, section 2). The result is never looser than the stricter of the two, and nothing
 * is lost:
 * - rules: the account's set stays whole; choice "device" asks for the device's set through proposeRules, so its
 *   tighter parts apply now and its looser parts need the agent, then the morning;
 * - today's minutes are added, per kind and per site; exam mode, if either has it, keeps the later end;
 * - the account's passes, cooldowns and waiting loosening are kept, the joining device's are dropped;
 * - chat, log and history are interleaved by time; the rules that lost are kept in the log for 30 days.
 */
export function join(account, local, choice = "account", now) {
  let a = engine.rollover(engine.upgrade(structuredClone(account)), now);
  const t = a.clock.floor;
  const l = engine.rollover(engine.upgrade(structuredClone(local)), t);
  const sameDay = a.usage.day === l.usage.day;
  if (sameDay) {
    const seconds = { ...a.usage.seconds }, upTo = { ...(a.usage.upTo || {}) }, passes = { ...a.usage.passes };
    for (const [b, v] of Object.entries(l.usage.seconds || {})) seconds[b] = (seconds[b] || 0) + v;
    for (const [b, v] of Object.entries(l.usage.upTo || {})) upTo[b] = Math.max(upTo[b] || 0, v);
    for (const [k, v] of Object.entries(l.usage.passes || {})) passes[k] = (passes[k] || 0) + v;
    a = { ...a, usage: { ...a.usage, seconds, upTo, passes, twice: (a.usage.twice || 0) + (l.usage.twice || 0), gates: (a.usage.gates || 0) + (l.usage.gates || 0) } };
  }
  const ea = engine.examOn(a) ? a.rules.exam : null, el = engine.examOn({ ...l, clock: a.clock }) ? l.rules.exam : null;
  if (el && (!ea || el.until > ea.until)) a = { ...a, rules: { ...a.rules, exam: el }, pending: a.pending && { ...a.pending, rules: { ...a.pending.rules, exam: el } } };
  const merge = (x, y, max) => [...(x || []), ...(y || [])].sort(byAt).slice(-max);
  const days = new Map((l.history || []).map((h) => [h.day, h]));
  for (const h of a.history || []) days.set(h.day, h);
  a = {
    ...a,
    goal: a.goal || l.goal || "",
    setupDone: a.setupDone || l.setupDone,
    sorted: { ...(l.sorted || {}), ...(a.sorted || {}) },
    judged: { ...(l.judged || {}), ...(a.judged || {}) },
    thread: { turns: merge(a.thread && a.thread.turns, l.thread && l.thread.turns, engine.MAX_TURNS), card: a.thread ? a.thread.card : null },
    history: [...days.values()].sort((x, y) => (x.day < y.day ? -1 : 1)).slice(-engine.HISTORY_DAYS),
    log: merge(a.log, l.log, engine.MAX_LOG),
  };
  const lost = choice === "device" ? a.rules : l.rules;
  a = { ...a, log: engine.logEvent(a, "join", { kept: choice === "device" ? "device" : "account", lostRules: engine.cleanRules(lost, a.rules), until: t + 30 * 86400e3 }) };
  if (choice === "device") {
    const r = engine.proposeRules(a, { ...l.rules, exam: a.rules.exam }, t, { source: "join" });
    return { state: r.state, now: r.now, later: r.later, needsOk: !!r.needsOk, refused: r.refused };
  }
  return { state: a, now: [], later: [], needsOk: false };
}

/** Leaving: the device keeps a full copy (rules, today's minutes, exam mode) and carries on alone. Nothing loosens. */
export function leaveCopy(account, local = {}) {
  const mine = Object.fromEntries(DEVICE_FIELDS.filter((k) => k in local).map((k) => [k, local[k]]));
  return engine.upgrade({ ...copyFor(account), ...mine });
}

/** Whether two rule sets differ, so joining needs the "use its rules here?" question. */
export function rulesDiffer(a, b) {
  return engine.describeChanges(engine.cleanRules(a.rules, a.rules), engine.cleanRules(b.rules, a.rules)).length > 0;
}
