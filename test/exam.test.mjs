// Exam mode and the Mac app's snapshot (contract version 1, ~/gatekeeper-mac/docs/contract.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, decide, tick, proposeRules, closedDomains, gateRequest, setHelp, startExam, endExam, examOn,
  applyMacRequest, snapshot, snapshotKey, todaySummary, rollover, EXAM_END_SENTENCE,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T20:00:00-04:00");
const WED = at("2026-10-21T08:30:00-04:00");
const visit = (url, now) => ({ url, title: "", focused: true, active: true, seconds: 2, now });
const setUp = (kinds) => ({ ...completeSetup(initialState(), { kinds, goal: "Finish problem set 4" }, MON).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" });

test("exam.start closes every kind at once, watched or not, until the end time", () => {
  const s = applyMacRequest(setUp({ social: 15 }), { type: "exam.start", until: WED, goal: "15.425 midterm" }, MON).state;
  assert.ok(examOn(s));
  for (const u of ["https://www.instagram.com/", "https://www.youtube.com/", "https://www.amazon.com/"]) {
    const d = decide(s, { url: u, now: MON + 60e3 });
    assert.equal(d.verdict, "block", u);
    assert.equal(d.exam.goal, "15.425 midterm");
    assert.equal(d.reopensAt, WED);
  }
  assert.equal(decide(s, { url: "https://canvas.mit.edu/", now: MON }).verdict, "allow");
  assert.ok(closedDomains(s, MON).includes("youtube.com"), "Video is not watched, and is still closed");
  assert.equal(decide(s, { url: "https://www.youtube.com/", now: WED + 1 }).verdict, "allow", "it ends by itself");
});

test("the later end wins; an earlier one, or no exam at all, does not shorten it", () => {
  let s = startExam(setUp({}), { until: WED, goal: "midterm" }, MON).state;
  s = startExam(s, { until: WED - 3600e3 }, MON).state;
  assert.equal(s.rules.exam.until, WED);
  s = startExam(s, { until: WED + 3600e3 }, MON).state;
  assert.equal(s.rules.exam.until, WED + 3600e3);
  const dropped = proposeRules(s, { ...s.rules, exam: null }, MON).state;
  assert.ok(examOn(dropped), "removing it from the rules waits for the morning, like any loosening");
  assert.equal(startExam(s, { until: MON - 1 }, MON).refused, "bad_until");
  assert.ok(startExam(setUp({}), { until: MON + 60 * 86400e3 }, MON).state.rules.exam.until <= MON + 14 * 86400e3, "at most 14 days");
});

test("exam.end only with the sentence, word for word", () => {
  const s = startExam(setUp({}), { until: WED }, MON).state;
  assert.equal(applyMacRequest(s, { type: "exam.end", sentence: "stop" }, MON).refused, "wrong_sentence");
  assert.equal(applyMacRequest(s, { type: "exam.end" }, MON).refused, "wrong_sentence");
  const off = applyMacRequest(s, { type: "exam.end", sentence: "  " + EXAM_END_SENTENCE + " " }, MON).state;
  assert.ok(!examOn(off));
  assert.equal(decide(off, { url: "https://www.youtube.com/", now: MON }).verdict, "allow");
  assert.equal(endExam(off, EXAM_END_SENTENCE, MON).refused, "not_on");
  assert.equal(applyMacRequest(s, { type: "exam.pause" }, MON).refused, "unknown_type");
});

test("in exam mode the gate does not talk, and nothing counts", () => {
  let s = setHelp(startExam(setUp({ video: 20 }), { until: WED }, MON).state, true);
  assert.equal(gateRequest(s, { url: "https://www.youtube.com/", message: "lecture 6", now: MON }).refused, "exam");
  s = tick(s, visit("https://www.youtube.com/", MON)).state;
  assert.equal(s.usage.seconds.video || 0, 0);
});

test("exam mode survives a waiting loosening applied in the morning", () => {
  let s = setUp({ video: 20 });
  s = proposeRules(s, { ...s.rules, kinds: { video: { minutes: 60 } } }, MON).state;
  s = startExam(s, { until: WED, goal: "midterm" }, MON).state;
  const tue = rollover(s, at("2026-10-20T04:00:01-04:00"));
  assert.equal(tue.rules.kinds.video.minutes, 60);
  assert.ok(examOn(tue));
});

test("the snapshot follows the contract, with what the engine decided", () => {
  let s = setUp({ social: 15, video: 0 });
  s = tick(s, visit("https://www.instagram.com/", MON)).state;
  const snap = snapshot(s, MON + 2000, { extensionId: "kfikbbdocggfgfhaegkgkfomhmacdbjp" });
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.v, 1);
  assert.deepEqual(snap.pages, { rules: "pages/rules.html", talk: "pages/talk.html", week: "pages/week.html" });
  assert.equal(snap.endsAt, at("2026-10-20T04:00:00-04:00"));
  assert.deepEqual(snap.kinds, [
    { kind: "social", label: "Social media", minutes: 15, usedSeconds: 2, left: 15, status: "open" },
    { kind: "video", label: "Video", minutes: 0, usedSeconds: 0, left: 0, status: "closed" },
  ]);
  assert.equal(snap.pending, null);
  assert.equal(snap.exam, null);
  const e = snapshot(startExam(s, { until: WED, goal: "midterm" }, MON).state, MON, {});
  assert.deepEqual(e.exam, { until: WED, goal: "midterm" });
  assert.ok(e.kinds.every((k) => k.status === "closed"));
  assert.equal(todaySummary(startExam(s, { until: WED }, MON).state, MON).exam.until, WED);
});

test("a snapshot is sent again only when what the Mac shows changes, not every second", () => {
  let s = setUp({ social: 15 });
  const a = snapshot(tick(s, visit("https://www.instagram.com/", MON)).state, MON, {});
  const b = snapshot(tick(tick(s, visit("https://www.instagram.com/", MON)).state, visit("https://www.instagram.com/", MON + 2000)).state, MON + 4000, {});
  assert.equal(snapshotKey(a), snapshotKey(b));
  let c = s;
  for (let i = 0; i < 31; i++) c = tick(c, visit("https://www.instagram.com/", MON + i * 2000)).state;
  assert.notEqual(snapshotKey(a), snapshotKey(snapshot(c, MON + 62000, {})));
});
