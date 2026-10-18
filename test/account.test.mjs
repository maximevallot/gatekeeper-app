// One Gatekeeper per person, the engine's part (design steps 1 and 2): time as spans, and join and leave.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, setHelp, tick, decide, applySpans, applyGateAnswer, startExam, examOn, rollover, proposeRules, addTurn,
} from "../extension/engine/engine.js";
import { join, leaveCopy, copyFor, rebase, applyOp, createAccount, rulesDiffer, DEVICE_FIELDS } from "../extension/engine/account.js";

const at = (iso) => new Date(iso).getTime();
const SAT = at("2026-10-18T20:00:00-04:00");
const YT = "https://www.youtube.com/", IG = "https://www.instagram.com/";
const device = (kinds, id, help = true) => {
  const s = { ...completeSetup(initialState(), { kinds, goal: "Finish chapter 3" }, SAT).state, installId: id };
  return help ? setHelp(s, true) : s;
};
const front = (s, url, now) => tick(s, { url, focused: true, active: true, seconds: 5, now });

test("step 1: one device counts exactly as before; a span is reported with each tick", () => {
  let s = device({ video: 20 }, "a");
  let r;
  for (let i = 1; i <= 12; i++) r = front(s = (r ? r.state : s), YT, SAT + i * 5000);
  assert.equal(r.state.usage.seconds.video, 60);
  assert.deepEqual(r.span, { from: SAT + 55e3, to: SAT + 60e3, buckets: ["video"], twice: [] });
});

test("step 1: two devices with YouTube in front at the same moment count it once; two kinds at once count both", () => {
  let account = createAccount(device({ video: 20, social: 20 }, "a"), SAT);
  const spans = (url) => { let s = device({ video: 20, social: 20 }, "x"); const out = []; for (let i = 1; i <= 12; i++) { const r = front(s, url, SAT + i * 5000); s = r.state; out.push(r.span); } return out; };
  const brave = spans(YT), safari = spans(YT);
  account = applySpans(account, brave, { now: SAT + 60e3 });
  account = applySpans(account, safari, { now: SAT + 60e3 });
  assert.equal(account.usage.seconds.video, 60, "the same minute, once");
  account = applySpans(account, spans(IG), { now: SAT + 60e3 });
  assert.equal(account.usage.seconds.social, 60, "Instagram in front elsewhere at the same time counts too");
});

test("step 1: a pass runs down by real time, not once per device", () => {
  let account = createAccount(device({ video: 0 }, "a"), SAT);
  account = applyGateAnswer(account, { url: YT, answer: { decision: "allow", minutes: 5, reply: "ok" }, now: SAT }).state;
  const twoMin = (offset) => Array.from({ length: 24 }, (_, i) => ({ from: SAT + offset + i * 5000, to: SAT + offset + (i + 1) * 5000, buckets: [] }));
  account = applySpans(account, twoMin(0), { now: SAT + 120e3 });
  account = applySpans(account, twoMin(0), { now: SAT + 120e3 }); // the second browser, the same two minutes
  assert.equal(Math.round(account.passes["youtube.com"].secondsLeft), 180, "two of five minutes gone, not four");
});

test("step 1: a device's spans are cut to now, to five seconds each and to today, so its clock changes nothing", () => {
  let account = createAccount(device({ video: 20 }, "a"), SAT);
  account = applySpans(account, [{ from: SAT, to: SAT + 3600e3, buckets: ["video"] }], { now: SAT + 10e3 });
  assert.ok(account.usage.seconds.video <= 5, "an hour claimed in one span is at most five seconds");
  account = applySpans(account, [{ from: SAT + 86400e3, to: SAT + 86400e3 + 5000, buckets: ["video"] }], { now: SAT + 20e3 });
  assert.ok(account.usage.seconds.video <= 5, "a span in the future counts nothing");
  const shifted = applySpans(account, [{ from: SAT - 3600e3 + 25e3, to: SAT - 3600e3 + 30e3, buckets: ["video"] }], { shift: 3600e3, now: SAT + 30e3 });
  assert.equal(shifted.usage.seconds.video - account.usage.seconds.video, 5, "a device an hour behind is shifted to the account's time");
});

test("step 2, Maxime's case: Brave and Safari both set up with different rules; the account's set stays whole", () => {
  let brave = device({ social: 20, video: 30 }, "brave");
  let safari = device({ video: 15, games: 0 }, "safari");
  for (let i = 1; i <= 24; i++) brave = front(brave, YT, SAT + i * 5000).state;
  for (let i = 1; i <= 12; i++) safari = front(safari, YT, SAT + 200e3 + i * 5000).state;
  safari = startExam(safari, { until: SAT + 2 * 3600e3, goal: "midterm" }, SAT + 300e3).state;
  safari = addTurn(safari, "user", "limit lequipe", SAT + 100e3);
  brave = addTurn(brave, "user", "less social", SAT + 50e3);
  const account = createAccount(brave, SAT + 300e3);
  assert.ok(rulesDiffer(account, safari), "the rules differ, so the join asks");
  const j = join(account, safari, "account", SAT + 300e3);
  const s = j.state;
  assert.deepEqual(Object.keys(s.rules.kinds).sort(), ["social", "video"], "Brave's set, whole");
  assert.equal(s.rules.kinds.video.minutes, 30);
  assert.equal(s.usage.seconds.video, 180, "today's minutes are added: 2 min + 1 min");
  assert.ok(examOn(s), "Safari's exam mode stays on");
  assert.deepEqual(s.thread.turns.map((x) => x.text), ["less social", "limit lequipe"], "the chats are interleaved by time");
  const lost = s.log.find((e) => e.type === "join");
  assert.deepEqual(Object.keys(lost.lostRules.kinds).sort(), ["games", "video"], "the losing set is kept for 30 days");
});

test("step 2: \"use this device's rules instead\" is a rule change: tighter parts now, looser ones need the agent", () => {
  const account = createAccount(device({ social: 20, video: 30 }, "brave"), SAT);
  const safari = device({ video: 15, games: 0 }, "safari");
  const j = join(account, safari, "device", SAT);
  assert.equal(j.state.rules.kinds.video.minutes, 15, "Video 30 → 15 applies now");
  assert.equal(j.state.rules.kinds.games.minutes, 0, "Games closed applies now");
  assert.equal(j.state.rules.kinds.social.minutes, 20, "no longer watching Social is a loosening: still 20");
  assert.equal(j.needsOk, true);
  assert.deepEqual(j.state.loosen.changes, ["Social media: no longer watched"]);
});

test("step 2: the joining device's passes and waiting loosening are dropped; the account's are kept", () => {
  let account = createAccount(device({ video: 0 }, "a"), SAT);
  account = applyGateAnswer(account, { url: YT, answer: { decision: "allow", minutes: 5, reply: "ok" }, now: SAT }).state;
  let other = device({ social: 0 }, "b");
  other = applyGateAnswer(other, { url: IG, answer: { decision: "allow", minutes: 10, reply: "ok" }, now: SAT }).state;
  other = proposeRules(other, { ...other.rules, kinds: { social: { minutes: 60 } } }, SAT).state;
  const s = join(account, other, "account", SAT).state;
  assert.ok(s.passes["youtube.com"]);
  assert.equal(s.passes["instagram.com"], undefined);
  assert.equal(s.loosen, null);
  assert.equal(decide(s, { url: IG, now: SAT }).verdict, "allow", "Social isn't in the account's rules");
});

test("leaving keeps a full copy and loosens nothing; the copy a device gets has no device fields", () => {
  let account = createAccount(device({ video: 20 }, "a"), SAT);
  account = startExam(account, { until: SAT + 3600e3 }, SAT).state;
  account = applySpans(account, [{ from: SAT, to: SAT + 5000, buckets: ["video"] }], { now: SAT + 5000 });
  const copy = copyFor({ ...account, calendar: { url: "https://x" }, sorting: true });
  for (const k of DEVICE_FIELDS) assert.ok(!(k in copy), k);
  assert.equal(copy.installId, account.installId, "the account's ID is the install number, for the daily allowance");
  const left = leaveCopy(account, { clock: { floor: SAT + 6000, guard: true }, calendar: { url: "https://x.edu/c.ics", events: [] } });
  assert.ok(examOn(left));
  assert.equal(left.usage.seconds.video, 5);
  assert.equal(left.calendar.url, "https://x.edu/c.ics", "the calendar link stays where it was pasted");
});

test("rebase: a fresh copy, with what this device did since its last sync applied again on top", () => {
  let account = createAccount(device({ video: 20, social: 20 }, "a"), SAT);
  account = applySpans(account, [{ from: SAT, to: SAT + 5000, buckets: ["video"] }], { now: SAT + 5000 });
  const local = { ...device({ video: 20, social: 20 }, "b"), clock: { floor: SAT + 15e3, guard: true } };
  const s = rebase(local, copyFor(account), {
    spans: [{ from: SAT + 5000, to: SAT + 10e3, buckets: ["video"] }, { from: SAT + 10e3, to: SAT + 15e3, buckets: ["social"] }],
    ops: [{ type: "propose", rules: { ...account.rules, kinds: { video: { minutes: 10 }, social: { minutes: 20 } } } }],
    now: SAT + 15e3,
  });
  assert.equal(s.usage.seconds.video, 10);
  assert.equal(s.usage.seconds.social, 5);
  assert.equal(s.rules.kinds.video.minutes, 10, "the tightening done offline is kept");
  assert.equal(s.installId, "a", "the account's ID");
  assert.equal(s.clock.guard, true);
  assert.equal(applyOp(s, { type: "chat", message: "hi" }, SAT).refused, "online_only");
  assert.equal(applyOp(s, { type: "nonsense" }, SAT).refused, "unknown_op");
  assert.equal(applyOp(s, { type: "sorted", domain: "lequipe.fr", kind: "news" }, SAT).state.sorted["lequipe.fr"], "news");
});
