// The rules chat knows exam mode (one-model plan, gap 1): it is sent the mode and the time, and can start or
// extend it now, or ask to end it early, which becomes a request to the agent.
import test from "node:test";
import assert from "node:assert/strict";
import { initialState, completeSetup, setHelp, chatRequest, chatPreview, startExam, examOn, localIso } from "../extension/engine/engine.js";
import { applyDiff } from "../extension/engine/videos.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T20:00:00-04:00");
const WED = at("2026-10-22T08:30:00-04:00");
const setUp = () => setHelp({ ...completeSetup(initialState(), { kinds: { video: 20 }, goal: "Midterm" }, MON).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" }, true);

test("the chat is sent exam mode and the local time with its offset", () => {
  const off = chatRequest(setUp(), { message: "hi", now: MON }).payload;
  assert.equal(off.exam, null);
  assert.equal(off.now, "2026-10-19T20:00:00-04:00");
  const on = chatRequest(startExam(setUp(), { until: WED, goal: "15.425 midterm" }, MON).state, { message: "hi", now: MON }).payload;
  assert.deepEqual(on.exam, { until: "2026-10-22T08:30:00-04:00", goal: "15.425 midterm" }, "until as local time with its offset (shared names)");
  assert.equal(localIso(MON), "2026-10-19T20:00:00-04:00");
});

test("examStart's until may come as local time with its offset, as the relay sends it", () => {
  const p = chatPreview(setUp(), { reply: "ok", diff: [{ op: "examStart", until: "2026-10-22T08:30:00-04:00", goal: "midterm" }] }, MON);
  assert.equal(p.rules.exam.until, WED);
});

test("examStart from the chat starts exam mode, applying now", () => {
  const p = chatPreview(setUp(), { reply: "Exam mode until Wednesday 8:30.", diff: [{ op: "examStart", until: WED, goal: "15.425 midterm" }] }, MON);
  assert.deepEqual(p.rules.exam, { until: WED, goal: "15.425 midterm" });
  assert.ok(p.now.some((c) => /Exam mode until/.test(c.text)));
  assert.equal(p.later.length, 0);
  const past = chatPreview(setUp(), { reply: "ok", diff: [{ op: "examStart", until: MON - 1 }] }, MON);
  assert.ok(!past.rules.exam && past.skipped === 1, "an end in the past is left out");
  const far = chatPreview(setUp(), { reply: "ok", diff: [{ op: "examStart", until: MON + 90 * 86400e3 }] }, MON);
  assert.equal(far.rules.exam.until, MON + 14 * 86400e3);
});

test("examEnd from the chat is a request to the agent, never an end by itself", () => {
  const s = startExam(setUp(), { until: WED }, MON).state;
  const p = chatPreview(s, { reply: "I can ask for that.", diff: [{ op: "examEnd" }] }, MON);
  assert.equal(p.examEnd, true);
  assert.ok(p.later.some((c) => c.text === "End exam mode early" && c.agent));
  assert.ok(examOn({ ...s, rules: p.rules }));
  assert.equal(chatPreview(setUp(), { reply: "ok", diff: [{ op: "examEnd" }] }, MON).examEnd, false, "nothing to end");
});

test("the lequipe sentence: a site put in news is closed in exam mode, and news stays free on normal days", () => {
  const s = startExam(setUp(), { until: WED }, MON).state;
  const p = chatPreview(s, { reply: "Exam mode closes news along with every other kind.", diff: [{ op: "site", domain: "lequipe.fr", kind: "news" }] }, MON);
  assert.equal(p.rules.sites["lequipe.fr"], "news");
  assert.ok(p.now.some((c) => /lequipe\.fr: counted as news/.test(c.text)));
  assert.deepEqual(p.needsAccess, ["lequipe.fr"]);
  assert.deepEqual(applyDiff({ kinds: {}, sites: {} }, [{ op: "examStart", until: "soon" }]).skipped.length, 1);
});
