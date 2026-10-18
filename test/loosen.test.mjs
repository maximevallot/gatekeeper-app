// The agent holds the key to loosening (2026-10-17): with Claude help on, a loosening needs its yes, then the
// morning; a no keeps the rule until tomorrow; without help, or if it can't be reached, as before.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, proposeRules, rollover, decide, setHelp, loosenRequest, applyLoosenAnswer, loosenUnavailable,
  startExam, endExam, examOn, weekSummary, WHATS_SENT, CONSENT,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T22:00:00-04:00");
const TUE = at("2026-10-20T04:00:01-04:00");
const setUp = (help = true) => {
  const s = { ...completeSetup(initialState(), { kinds: { video: 20, social: 15 }, goal: "Finish the 15.390 slides" }, MON).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" };
  return help ? setHelp(s, true) : s;
};
const more = (s) => proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, video: { minutes: 45 } } }, MON);
const yes = { decision: "allow", reply: "OK: 45 minutes from tomorrow morning." };
const no = { decision: "deny", reply: "The rule stays." };
const ask = { decision: "ask", reply: "What changed?" };

test("with Claude help on, a loosening waits for the agent's yes, and then for the morning", () => {
  const r = more(setUp());
  assert.equal(r.needsOk, true);
  assert.deepEqual(r.state.loosen.changes, ["Video: 20 min a day → 45 min a day"]);
  assert.equal(rollover(r.state, TUE).rules.kinds.video.minutes, 20, "no yes: the morning does not apply it");
  const req = loosenRequest(r.state, { message: "Two lecture recordings a day now", now: MON });
  assert.deepEqual(req.payload, { installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", kind: "rules", goal: "Finish the 15.390 slides",
    changes: ["Video: 20 min a day → 45 min a day"], asked: "", message: "Two lecture recordings a day now", exam: null, now: "2026-10-19T22:00:00-04:00" });
  const a = applyLoosenAnswer(r.state, { answer: yes, message: "Two lecture recordings a day now", now: MON });
  assert.equal(a.result.decision, "allow");
  assert.equal(a.state.rules.kinds.video.minutes, 20, "a yes still waits for the morning");
  assert.equal(rollover(a.state, TUE).rules.kinds.video.minutes, 45);
});

test("a yes the morning after still waits for the next morning", () => {
  const r = more(setUp());
  const late = applyLoosenAnswer(r.state, { answer: yes, now: TUE + 3600e3 }).state;
  assert.equal(rollover(late, TUE + 7200e3).rules.kinds.video.minutes, 20);
  assert.equal(rollover(late, at("2026-10-21T04:00:01-04:00")).rules.kinds.video.minutes, 45);
});

test("a no keeps the rule, and the same request waits until tomorrow", () => {
  const r = more(setUp());
  const d = applyLoosenAnswer(r.state, { answer: no, message: "I just want more", now: MON });
  assert.equal(d.result.decision, "deny");
  assert.equal(d.state.pending, null);
  assert.equal(rollover(d.state, TUE).rules.kinds.video.minutes, 20);
  const again = more(d.state);
  assert.equal(again.refused, "asked_today");
  assert.equal(again.state.pending, null);
  assert.ok(more({ ...d.state }).refused);
  const tomorrow = proposeRules(d.state, { ...d.state.rules, kinds: { ...d.state.rules.kinds, video: { minutes: 45 } } }, TUE);
  assert.ok(!tomorrow.refused && tomorrow.needsOk, "tomorrow it can be asked again");
});

test("one question, then the agent must decide: a second question counts as no", () => {
  const r = more(setUp());
  const q = applyLoosenAnswer(r.state, { answer: ask, now: MON });
  assert.equal(q.result.decision, "ask");
  assert.equal(loosenRequest(q.state, { message: "school", now: MON }).payload.asked, "What changed?");
  assert.equal(applyLoosenAnswer(q.state, { answer: ask, now: MON }).result.decision, "deny");
});

test("tightening needs no agent", () => {
  const s = setUp();
  const r = proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, video: { minutes: 10 } } }, MON);
  assert.equal(r.needsOk, undefined);
  assert.equal(r.state.rules.kinds.video.minutes, 10);
  assert.equal(r.state.loosen, null);
});

test("without Claude help ever on, a loosening waits for the morning; with the agent out of reach, it keeps waiting (QA round 2, H2)", () => {
  const off = more(setUp(false));
  assert.equal(off.needsOk, false);
  assert.equal(rollover(off.state, TUE).rules.kinds.video.minutes, 45);
  const r = more(setUp());
  for (const error of ["unreachable", "daily_limit", "http_500"]) {
    const u = loosenUnavailable(r.state, { message: "lectures", error, now: MON }).state;
    assert.equal(u.loosen.kind, "rules", `${error}: the request keeps waiting`);
    assert.equal(rollover(u, TUE).rules.kinds.video.minutes, 20, `${error}: nothing loosens without the agent's yes`);
    assert.equal(u.log.filter((e) => e.type === "loosen").at(-1).decision, "unavailable");
    assert.ok(loosenRequest(u, { message: "lectures", now: MON }).payload, "and it can be asked again later");
  }
});

test("turning Claude help off is itself a loosening: until the morning, a loosening is refused; then the morning alone", () => {
  const s = setHelp(setUp(), false);
  const r = more(s);
  assert.equal(r.refused, "help_off_today");
  assert.equal(rollover(r.state, TUE).rules.kinds.video.minutes, 20, "nothing waits for the morning");
  const next = more(rollover(s, TUE));
  assert.equal(next.needsOk, false, "from the next morning, with help off, the morning rule as before");
  assert.equal(rollover(next.state, TUE + 86400e3).rules.kinds.video.minutes, 45);
  // A request already waiting for the agent when help goes off is not approved by it.
  const waiting = setHelp(more(setUp()).state, false);
  assert.equal(rollover(waiting, TUE).rules.kinds.video.minutes, 20);
  assert.equal(more(waiting).refused, "help_off_today");
});

test("after a no, no loosening of the rules is asked until the morning: not one minute more (QA round 2, H3)", () => {
  const r = more(setUp());
  const n = applyLoosenAnswer(r.state, { answer: no, message: "I just want more", now: MON }).state;
  const again = proposeRules(n, { ...n.rules, kinds: { ...n.rules.kinds, video: { minutes: 44 } } }, MON);
  assert.equal(again.refused, "asked_today");
  assert.equal(again.state.loosen, null);
  const other = proposeRules(n, { ...n.rules, kinds: { ...n.rules.kinds, social: { minutes: 30 } } }, MON);
  assert.equal(other.refused, "asked_today", "nor another rule");
  assert.equal(proposeRules(n, { ...n.rules, kinds: { ...n.rules.kinds, social: { minutes: 5 } } }, MON).now.length, 1, "tightening still applies");
  assert.equal(more(rollover(n, TUE)).needsOk, true, "tomorrow it can be asked again");
});

test("an approved change stays approved: a second loosening asks only about itself, and its no keeps the first (QA round 2, H1)", () => {
  let s = applyLoosenAnswer(more(setUp()).state, { answer: yes, message: "lectures", now: MON }).state;
  assert.equal(s.pending.ok, true);
  const r = proposeRules(s, { ...s.pending.rules, kinds: { ...s.pending.rules.kinds, social: { minutes: 30 } } }, MON);
  assert.deepEqual(r.state.loosen.changes, ["Social media: 15 min a day → 30 min a day"], "only what is new is asked");
  const n = applyLoosenAnswer(r.state, { answer: no, message: "just because", now: MON }).state;
  const tue = rollover(n, TUE);
  assert.equal(tue.rules.kinds.video.minutes, 45, "the approved change still applies in the morning");
  assert.equal(tue.rules.kinds.social.minutes, 15);
  // Turning Claude help on does not put a change already waiting for the morning behind the agent (first-run H4).
  const offWaiting = more(setUp(false)).state;
  const on = setHelp(offWaiting, true);
  const r2 = proposeRules(on, { ...on.pending.rules, kinds: { ...on.pending.rules.kinds, social: { minutes: 10 } } }, MON);
  assert.equal(r2.needsOk, false);
  assert.equal(rollover(r2.state, TUE).rules.kinds.video.minutes, 45);
});

test("ending exam mode early: the agent decides; a yes ends it at once only once the exam on the calendar has begun", () => {
  const WED = at("2026-10-22T08:30:00-04:00");
  const s0 = startExam(setUp(), { until: WED, goal: "midterm" }, MON).state;
  // QA round 2, C3: "it's over" two days before the exam. With no exam begun on the calendar, a "now" is the morning.
  const early = applyLoosenAnswer(endExam(s0, MON).state, { answer: { ...yes, when: "now" }, message: "exam is over", now: MON });
  assert.ok(examOn(early.state), "no exam has begun: not at once");
  assert.equal(early.result.now, false);
  assert.equal(loosenRequest(endExam(s0, MON).state, { message: "exam is over", now: MON }).payload.exam.examAt, null);
  // The calendar has the midterm at 20:00 tonight, inside exam mode, and it has begun.
  const EXAM = MON - 2 * 3600e3;
  const s = { ...s0, calendar: { url: "https://x.edu/cal.ics", events: [{ title: "Midterm 15.425", start: EXAM }], fetchedAt: MON, error: null },
    rules: { ...s0.rules, exam: { ...s0.rules.exam, from: EXAM - 3600e3 } } };
  assert.equal(loosenRequest(endExam(s, MON).state, { message: "done", now: MON }).payload.exam.examAt, "2026-10-19T20:00:00-04:00");
  const e = endExam(s, MON);
  assert.equal(e.needsOk, true);
  assert.ok(examOn(e.state), "not before the agent's yes");
  assert.equal(loosenRequest(e.state, { message: "The exam was moved to next month", now: MON }).payload.kind, "exam");
  const y = applyLoosenAnswer(e.state, { answer: yes, now: MON }).state;
  assert.ok(examOn(y), "still on tonight");
  assert.ok(!examOn(rollover(y, TUE)), "over in the morning");
  const done = applyLoosenAnswer(e.state, { answer: { ...yes, when: "now" }, now: MON });
  assert.ok(!examOn(done.state), "the exam is over: it ends at once");
  assert.equal(done.result.now, true);
  assert.ok(examOn(applyLoosenAnswer(e.state, { answer: { ...yes, when: "morning" }, now: MON }).state), "when: morning waits for the morning");
  const n = applyLoosenAnswer(e.state, { answer: no, now: MON }).state;
  assert.ok(examOn(rollover(n, TUE)));
  assert.equal(endExam(n, MON).refused, "asked_today");
  assert.ok(examOn(loosenUnavailable(e.state, { now: MON }).state), "out of reach: exam mode stays on");
});

test("every request and answer is logged on the device, and the week counts them", () => {
  let r = more(setUp());
  let s = applyLoosenAnswer(r.state, { answer: no, message: "I just want more", now: MON }).state;
  r = proposeRules(rollover(s, TUE), { ...s.rules, kinds: { ...s.rules.kinds, social: { minutes: 30 } } }, TUE);
  s = applyLoosenAnswer(r.state, { answer: yes, message: "Group project chat lives there this week", now: TUE }).state;
  assert.deepEqual(s.log.filter((e) => e.type === "loosen").map((e) => [e.decision, e.message]), [["deny", "I just want more"], ["allow", "Group project chat lives there this week"]]);
  const w = weekSummary(s, TUE);
  assert.equal(w.loosenAsked, 2);
  assert.equal(w.loosenAllowed, 1);
});

test("Claude help's list of what is sent names the loosening request, and its version went up", () => {
  assert.ok(WHATS_SENT.some((w) => /loosen/i.test(w.what) && /reason/.test(w.sent)));
  assert.ok(CONSENT.help >= 2);
});
