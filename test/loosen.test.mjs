// The agent holds the key to loosening (2026-10-17): with Claude help on, a loosening needs its yes, then the
// morning; a no keeps the rule until tomorrow; without help, or if it can't be reached, as before.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, proposeRules, rollover, decide, setHelp, loosenRequest, applyLoosenAnswer, loosenUnavailable,
  startExam, endExam, examOn, weekSummary, EXAM_END_SENTENCE, WHATS_SENT, CONSENT,
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
    changes: ["Video: 20 min a day → 45 min a day"], asked: "", message: "Two lecture recordings a day now" });
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

test("without Claude help, or with the agent out of reach, a loosening waits for the morning as before", () => {
  const off = more(setUp(false));
  assert.equal(off.needsOk, false);
  assert.equal(rollover(off.state, TUE).rules.kinds.video.minutes, 45);
  const r = more(setUp());
  const u = loosenUnavailable(r.state, { message: "lectures", error: "unreachable", now: MON }).state;
  assert.equal(u.loosen, null);
  assert.equal(rollover(u, TUE).rules.kinds.video.minutes, 45, "nobody is locked in");
  assert.equal(u.loosenLog.at(-1).decision, "unavailable");
});

test("ending exam mode early: the sentence, then the agent; a yes ends it the next morning", () => {
  const WED = at("2026-10-22T08:30:00-04:00");
  let s = startExam(setUp(), { until: WED, goal: "midterm" }, MON).state;
  assert.equal(endExam(s, "stop", MON).refused, "wrong_sentence");
  const e = endExam(s, EXAM_END_SENTENCE, MON);
  assert.equal(e.needsOk, true);
  assert.ok(examOn(e.state), "not before the agent's yes");
  assert.equal(loosenRequest(e.state, { message: "The exam was moved to next month", now: MON }).payload.kind, "exam");
  const y = applyLoosenAnswer(e.state, { answer: yes, now: MON }).state;
  assert.ok(examOn(y), "still on tonight");
  assert.ok(!examOn(rollover(y, TUE)), "over in the morning");
  const n = applyLoosenAnswer(e.state, { answer: no, now: MON }).state;
  assert.ok(examOn(rollover(n, TUE)));
  assert.equal(endExam(n, EXAM_END_SENTENCE, MON).refused, "asked_today");
  // Without Claude help, the sentence ends it at once, as before.
  assert.ok(!examOn(endExam(startExam(setUp(false), { until: WED }, MON).state, EXAM_END_SENTENCE, MON).state));
});

test("every request and answer is logged on the device, and the week counts them", () => {
  let r = more(setUp());
  let s = applyLoosenAnswer(r.state, { answer: no, message: "I just want more", now: MON }).state;
  r = proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, social: { minutes: 30 } } }, MON);
  s = applyLoosenAnswer(r.state, { answer: yes, message: "Group project chat lives there this week", now: MON }).state;
  assert.deepEqual(s.loosenLog.map((e) => [e.decision, e.message]), [["deny", "I just want more"], ["allow", "Group project chat lives there this week"]]);
  const w = weekSummary(s, MON);
  assert.equal(w.loosenAsked, 2);
  assert.equal(w.loosenAllowed, 1);
});

test("Claude help's list of what is sent names the loosening request, and its version went up", () => {
  assert.ok(WHATS_SENT.some((w) => /loosen/i.test(w.what) && /reason/.test(w.sent)));
  assert.equal(CONSENT.help, 2);
});
