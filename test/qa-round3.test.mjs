// QA round 3 (2026-10-18, ~/gatekeeper-app-qa/round3/RANKED.md), the extension's findings: each exact case.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, setHelp, proposeRules, rollover, decide, tick, startExam, endExam, examOn, examAt, gateRequest,
  applyGateAnswer, applyLoosenAnswer, guardClock, confirmTime, timeCheckNeeded, strictNow, chatRequest, chatPreview, recordChatAnswer,
  applyCard, MAX_DRIFT_MS, GAP_GRACE_MS,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const SAT = at("2026-10-17T22:00:00-04:00");
const ID = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
const setUp = (kinds, help = true) => {
  const s = { ...completeSetup(initialState(), { kinds, goal: "Finish chapter 3" }, SAT).state, installId: ID };
  return help ? setHelp(s, true) : s;
};
// A worker ticking: wall time `now`, monotonic `mono`, in one run of the worker.
const tickAt = (s, url, now, mono, run = "run1") => tick(s, { url, focused: true, active: true, seconds: 2, now, mono, run }).state;

test("#1 (gate N1, Critical): a Quiz added to the calendar during exam mode doesn't end a midterm's exam mode at once", () => {
  const MIDTERM = SAT + 40 * 3600e3;
  let s = startExam(setUp({ video: 0 }), { until: MIDTERM, goal: "Midterm 15.425", at: MIDTERM, source: "calendar" }, SAT).state;
  assert.equal(s.rules.exam.at, MIDTERM, "the exam's own time is fixed when exam mode starts");
  s = { ...s, calendar: { url: "https://cal.example/feed.ics", events: [{ title: "Quiz", start: SAT + 30 * 60e3 }, { title: "Midterm 15.425", start: MIDTERM }], fetchedAt: SAT, error: null } };
  const now = SAT + 31 * 60e3;
  assert.equal(examAt(rollover(s, now)), null, "the quiz isn't the exam");
  const e = endExam(s, now);
  const r = applyLoosenAnswer(e.state, { answer: { decision: "allow", when: "now", reply: "OK: exam mode ends now." }, message: "exam is over", now });
  assert.ok(examOn(r.state), "a yes with \"now\" still waits for the morning");
  assert.equal(r.result.now, false);
  // A later start keeps the exam's own time where it was: it never moves earlier.
  s = startExam(s, { until: MIDTERM + 3600e3, at: SAT + 60e3 }, now).state;
  assert.equal(s.rules.exam.at, MIDTERM);
});

test("#2 (first-run N1): after Brave was closed past 4:00, the day turns over even with the relay out of reach; exam mode waits for the relay", () => {
  let s = guardClock(setUp({ social: 1 }));
  for (let i = 1; i <= 35; i++) s = tickAt(s, "https://www.reddit.com/", SAT + i * 2000, i * 2000);
  assert.equal(decide(s, { url: "https://www.reddit.com/", now: SAT + 72e3 }).verdict, "gate", "Social spent");
  s = startExam(s, { until: SAT + 6 * 3600e3, goal: "x" }, SAT + 72e3).state;
  // Brave closed; 9 hours later it starts again: a new worker, and nothing has answered from the relay.
  const MORNING = at("2026-10-18T07:00:00-04:00");
  s = tickAt(s, "https://www.reddit.com/", MORNING, 1000, "run2");
  assert.equal(timeCheckNeeded(s), true, "it asks the relay");
  assert.equal(s.usage.day, "2026-10-18", "the browser wasn't running: the night counts as real for the day");
  assert.equal(decide(s, { url: "https://www.reddit.com/", now: MORNING }).verdict, "block", "exam mode, on sure time, still holds");
  assert.ok(strictNow(s) < SAT + 6 * 3600e3);
  s = confirmTime(s, { server: MORNING + 2000, local: MORNING + 2000, mono: 3000, run: "run2" });
  assert.ok(!examOn(s), "the relay's time ends exam mode at its set end");
  assert.equal(decide(s, { url: "https://www.reddit.com/", now: MORNING + 3000 }).verdict, "allow", "and Social is open again");
});

test("#2: the computer asleep with the worker running: one tick spans the night; after 20 s without the relay, the day takes it", () => {
  let s = guardClock(setUp({ social: 1 }));
  for (let i = 1; i <= 35; i++) s = tickAt(s, "https://www.reddit.com/", SAT + i * 2000, i * 2000);
  const MORNING = at("2026-10-18T07:00:00-04:00");
  s = tickAt(s, "https://www.reddit.com/", MORNING, 72e3); // monotonic time doesn't run in sleep
  assert.equal(s.usage.day, "2026-10-17", "a gap while running: the relay first, for a moment");
  for (let i = 1; i <= 12; i++) s = tickAt(s, "https://www.reddit.com/", MORNING + i * 2000, 72e3 + i * 2000);
  assert.ok(12 * 2000 >= GAP_GRACE_MS);
  assert.equal(s.usage.day, "2026-10-18", "no answer for 20 s: the night is real for the day");
  assert.equal(decide(s, { url: "https://www.reddit.com/", now: MORNING + 25e3 }).verdict, "allow");
});

test("#6 (gate N2): walking the clock forward in 14-minute steps doesn't end exam mode or start tomorrow", () => {
  let s = guardClock(startExam(setUp({ social: 0 }), { until: SAT + 2 * 3600e3, goal: "x" }, SAT).state);
  let wall = SAT, mono = 0;
  for (let i = 0; i < 35; i++) { wall += 14 * 60e3 + 2000; mono += 2000; s = tickAt(s, "https://example.org/", wall, mono); }
  assert.ok(14 * 60e3 > MAX_DRIFT_MS);
  assert.equal(timeCheckNeeded(s), true);
  assert.ok(examOn(s), "exam mode stays on after 8 hours of fake time");
  assert.equal(s.usage.day, "2026-10-17", "no new day");
  s = confirmTime(s, { server: SAT + 70e3, local: wall, mono, run: "run1" });
  s = tickAt(s, "https://example.org/", wall + 2000, mono + 2000);
  assert.ok(examOn(s), "with the relay's time, still on");
  assert.equal(timeCheckNeeded(s), false);
});

test("#2/#6: small steps hold the clock; a night asleep after them still turns the day, and exam mode still holds", () => {
  let s = guardClock(startExam(setUp({ social: 1 }), { until: SAT + 30 * 3600e3, goal: "x" }, SAT).state);
  let wall = SAT, mono = 0;
  for (let i = 0; i < 3; i++) { wall += 14 * 60e3; mono += 2000; s = tickAt(s, "https://example.org/", wall, mono); }
  assert.equal(s.clock.held.kind, "drift");
  const MORNING = at("2026-10-18T09:00:00-04:00");
  s = tickAt(s, "https://example.org/", MORNING, mono + 2000);
  for (let i = 1; i <= 12; i++) s = tickAt(s, "https://example.org/", MORNING + i * 2000, mono + 2000 + i * 2000);
  assert.equal(s.usage.day, "2026-10-18");
  assert.ok(examOn(s), "exam mode keeps to sure time");
});

test("a new install takes its first reading of the clock as it is, with the relay out of reach", () => {
  let s = guardClock(initialState());
  const now = SAT;
  s = rollover(s, now);
  assert.equal(s.clock.floor, now);
  s = tickAt(s, "https://example.org/", now + 2000, 5000);
  s = tickAt(s, "https://example.org/", now + 4000, 7000);
  assert.equal(s.clock.floor, now + 4000);
  assert.equal(timeCheckNeeded(s), false);
  // And from a first tick, not a plain read.
  let f = tickAt(guardClock(initialState()), "https://example.org/", now, 1000, "r9");
  f = tickAt(f, "https://example.org/", now + 2000, 3000, "r9");
  assert.equal(f.clock.floor, now + 2000);
  assert.equal(timeCheckNeeded(f), false);
});

test("#2/#6: an ordinary day of ticks never holds the clock", () => {
  let s = guardClock(setUp({ social: 30 }));
  for (let i = 1; i <= 900; i++) s = tickAt(s, "https://example.org/", SAT + i * 2000 + (i % 3), i * 2000);
  assert.equal(timeCheckNeeded(s), false);
  assert.equal(strictNow(s), s.clock.floor);
});

test("#8 (gate N4): moving a site between closed kinds doesn't give a fresh set of passes", () => {
  let s = setUp({ video: 0, social: 0, games: 0, news: 0, shopping: 0 });
  s = applyGateAnswer(s, { url: "https://www.youtube.com/", answer: { decision: "allow", minutes: 10, reply: "ok" }, now: SAT }).state;
  for (const kind of ["social", "games", "news", "shopping"]) {
    s = proposeRules(s, { ...s.rules, sites: { "youtube.com": kind } }, SAT).state;
    assert.equal(s.rules.sites["youtube.com"], kind);
    const r = gateRequest(s, { url: "https://www.youtube.com/", message: "lecture", now: SAT + 60e3 });
    assert.ok(r.refused === "cooldown" || r.refused === "open", `${kind}: ${r.refused}`);
  }
  assert.deepEqual(s.usage.passes, { video: 1 }, "one ladder, Video's");
});

test("#4 (chat N1): after a no, the chat tells the relay loosening is locked, and adds no line that contradicts it", () => {
  let s = setUp({ games: 15 });
  s = proposeRules(s, { ...s.rules, kinds: { games: { minutes: 30 } } }, SAT).state;
  s = applyLoosenAnswer(s, { answer: { decision: "deny", reply: "The rule stays." }, message: "more", now: SAT }).state;
  assert.equal(chatRequest(s, { message: "give games 30 min", now: SAT }).payload.loosenLocked, true);
  assert.equal(chatRequest(setUp({ games: 15 }), { message: "hi", now: SAT }).payload.loosenLocked, false);
  const answer = { reply: "I said no to a loosening today, so Games 30 waits: ask again after 4:00.", question: null, diff: [] };
  const p = chatPreview(s, answer, SAT);
  const after = recordChatAnswer(s, answer, p, SAT);
  assert.deepEqual(after.thread.turns.slice(-1).map((x) => x.text), [answer.reply], "only the relay's words");
});

test("#3 (chat N2): Apply on \"end exam mode\" says what can happen without a calendar", () => {
  let s = startExam(setUp({ video: 0 }), { until: SAT + 3 * 86400e3, goal: "x" }, SAT).state;
  s = { ...s, thread: { turns: [], card: { answer: { reply: "I can ask for that.", diff: [{ op: "examEnd" }] }, view: { now: [], later: [] } } } };
  const r = applyCard(s, SAT);
  assert.match(r.state.thread.turns.at(-1).text, /tomorrow morning at the earliest/);
});
