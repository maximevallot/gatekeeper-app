// One history log, and loosenings that wait in turn (one-model plan, gaps 10 and 11).
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, upgrade, completeSetup, setHelp, proposeRules, startExam, endExam, applyLoosenAnswer, applyGateAnswer,
  applyMacRequest, weekSummary,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T20:00:00-04:00");
const WED = at("2026-10-22T08:30:00-04:00");
const setUp = () => setHelp({ ...completeSetup(initialState(), { kinds: { video: 20, social: 15 }, goal: "Midterm" }, MON).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" }, true);
const yes = { decision: "allow", reply: "OK." };

test("a second loosening waits behind the first instead of replacing it", () => {
  let s = startExam(setUp(), { until: WED }, MON).state;
  s = endExam(s, MON).state;
  assert.equal(s.loosen.kind, "exam");
  s = proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, video: { minutes: 45 } } }, MON).state;
  assert.equal(s.loosen.kind, "exam", "the exam request is still the one being asked");
  assert.deepEqual(s.loosenQueue.map((q) => q.kind), ["rules"]);
  s = applyLoosenAnswer(s, { answer: yes, message: "The exam is over", now: MON }).state;
  assert.equal(s.loosen.kind, "rules", "then the rules change gets its turn");
  assert.deepEqual(s.loosen.changes, ["Video: 20 min a day → 45 min a day"]);
  assert.deepEqual(s.loosenQueue, []);
});

test("one log: rule changes, exam starts and ends with where they came from, passes and refusals", () => {
  let s = proposeRules(setUp(), { ...setUp().rules, kinds: { video: { minutes: 10 }, social: { minutes: 15 } } }, MON, { source: "rules" }).state;
  s = applyMacRequest(s, { type: "exam.start", until: WED, goal: "midterm" }, MON).state;
  s = endExam(s, MON).state;
  s = applyLoosenAnswer(s, { answer: { ...yes, when: "now" }, message: "It's over", now: MON }).state;
  s = { ...s, usage: { ...s.usage, seconds: { video: 600 } } };
  s = applyGateAnswer(s, { url: "https://www.youtube.com/watch?v=a", answer: { decision: "allow", minutes: 5, reply: "ok" }, now: MON }).state;
  s = applyGateAnswer(s, { url: "https://www.instagram.com/", answer: { decision: "deny", minutes: 0, reply: "No." }, now: MON }).state;
  const types = s.log.map((e) => e.type);
  assert.ok(types.includes("rules") && types.includes("exam.start") && types.includes("exam.end") && types.includes("loosen") && types.includes("pass") && types.includes("gate.no"), types);
  assert.equal(s.log.find((e) => e.type === "exam.start").source, "mac");
  assert.equal(s.log.find((e) => e.type === "rules" && e.source === "rules").now[0], "Video: 20 min a day → 10 min a day");
  assert.equal(s.log.find((e) => e.type === "exam.end").how, "agent, next morning", "no exam on the calendar has begun, so not at once");
  assert.equal(weekSummary(s, MON).examStarts, 1);
});

test("an older state's separate loosening log joins the one log", () => {
  const s = upgrade({ version: 2, rules: { kinds: {}, sites: {}, dayStart: 4 }, usage: { day: "2026-10-19", endsAt: WED, seconds: {}, passes: {} },
    loosenLog: [{ at: MON, decision: "deny", changes: ["x"] }] });
  assert.deepEqual(s.log.map((e) => [e.type, e.decision]), [["loosen", "deny"]]);
  assert.equal(s.loosenLog, undefined);
});
