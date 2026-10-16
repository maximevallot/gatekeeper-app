// Milestone 2 in the engine: passes, the gate's request and answer, and sorting unknown sites.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, upgrade, completeSetup, decide, tick, closedDomains, gateRequest, applyGateAnswer,
  recordSort, sortFailed, setTalk, setSorting, kindOf, COOLDOWN_MS,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const NOW = at("2026-10-19T21:40:00-04:00");
const YT = "https://www.youtube.com/watch?v=abc";
const visit = (url, now, extra = {}) => ({ url, title: "", focused: true, active: true, seconds: 2, now, ...extra });

function spent(kinds = { video: 20 }) {
  let s = completeSetup(initialState(), { kinds, goal: "Finish problem set 4" }, NOW).state;
  s = { ...s, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", usage: { day: "2026-10-19", seconds: { video: 20 * 60 } } };
  return s;
}

test("nothing is sent before the user says yes", () => {
  const s = spent();
  assert.deepEqual(gateRequest(s, { url: YT, message: "lecture 6", now: NOW }), { refused: "no_consent" });
  assert.equal(tick(s, visit("https://unknown-game.example/", NOW)).sort, null);
});

test("the gate sends only what /gate needs", () => {
  const s = setTalk(spent(), true);
  const r = gateRequest(s, { url: YT, message: "  I need the lecture 6 recording  ", now: NOW });
  assert.deepEqual(r.payload, {
    installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", goal: "Finish problem set 4", site: "youtube.com",
    kind: "video", minutesUsed: 20, budget: 20, deadlines: [], message: "I need the lecture 6 recording",
  });
  assert.deepEqual(gateRequest(s, { url: YT, message: "   ", now: NOW }), { refused: "empty" });
  assert.equal(gateRequest(s, { url: YT, message: "x".repeat(900), now: NOW }).payload.message.length, 500);
  // An open site has nothing to ask for.
  assert.deepEqual(gateRequest(setTalk(spent({ video: 60 }), true), { url: YT, message: "hi", now: NOW }), { refused: "open" });
});

test("allow grants a pass for the whole kind, then the gate comes back", () => {
  const s = setTalk(spent(), true);
  const { state, result } = applyGateAnswer(s, { kind: "video", answer: { decision: "allow", minutes: 5, reply: "Five minutes." }, now: NOW });
  assert.equal(result.decision, "allow");
  assert.equal(result.minutes, 5);
  const d = decide(state, { url: "https://vimeo.com/1", now: NOW + 60e3 });
  assert.equal(d.verdict, "allow");
  assert.equal(d.pass, true);
  assert.equal(d.leftMinutes, 4);
  assert.ok(!closedDomains(state, NOW + 60e3).includes("youtube.com"), "the redirect is lifted during the pass");
  assert.equal(decide(state, { url: YT, now: NOW + 5 * 60e3 + 1 }).verdict, "gate");
  assert.ok(closedDomains(state, NOW + 5 * 60e3 + 1).includes("youtube.com"));
});

test("a pass is 1 to 10 minutes whatever comes back", () => {
  const s = setTalk(spent(), true);
  const long = applyGateAnswer(s, { kind: "video", answer: { decision: "allow", minutes: 90, reply: "ok" }, now: NOW });
  assert.equal(long.result.minutes, 10);
  const zero = applyGateAnswer(s, { kind: "video", answer: { decision: "allow", minutes: 0, reply: "ok" }, now: NOW });
  assert.equal(zero.result.minutes, 1);
});

test("ask allows one follow-up; a second question, a no or garbage keeps the gate shut", () => {
  const s = setTalk(spent(), true);
  const ask = applyGateAnswer(s, { kind: "video", answer: { decision: "ask", minutes: 0, reply: "Which class?" }, now: NOW });
  assert.equal(ask.result.decision, "ask");
  assert.deepEqual(ask.state.cooldowns, {});
  const again = applyGateAnswer(s, { kind: "video", answer: { decision: "ask", minutes: 0, reply: "Which?" }, lastTurn: true, now: NOW });
  assert.equal(again.result.decision, "deny");
  const no = applyGateAnswer(s, { kind: "video", answer: { decision: "deny", minutes: 0, reply: "No." }, now: NOW });
  assert.equal(no.state.cooldowns.video, NOW + COOLDOWN_MS);
  assert.deepEqual(gateRequest(no.state, { url: YT, message: "please", now: NOW + 60e3 }).refused, "cooldown");
  assert.ok(gateRequest(no.state, { url: YT, message: "please", now: NOW + COOLDOWN_MS + 1 }).payload);
  for (const bad of [null, {}, { decision: "maybe", reply: "x" }, { decision: "allow" }]) {
    const r = applyGateAnswer(s, { kind: "video", answer: bad, now: NOW });
    assert.equal(r.result.decision, "error");
    assert.equal(r.state, s, "an error changes nothing: the gate stays shut");
  }
});

test("an unknown site is sorted once, after a minute in front, and then counts against its kind", () => {
  let s = setSorting(spent({ games: 15 }), true);
  const url = "https://paper-io.example/play";
  let sort = null, t = NOW;
  for (let i = 0; i < 29; i++) ({ state: s, sort } = tick(s, visit(url, (t += 2000))));
  assert.equal(sort, null, "not before 60 seconds");
  ({ state: s, sort } = tick(s, visit(url, (t += 2000))));
  assert.equal(sort, "paper-io.example");
  ({ state: s, sort } = tick(s, visit(url, (t += 2000))));
  assert.equal(sort, null, "asked once, not again while the answer is on its way");
  assert.equal(tick(s, visit(url, (t += 2000), { focused: false })).sort, null);
  s = recordSort(s, "paper-io.example", "games");
  assert.equal(kindOf(s, "https://www.paper-io.example/"), "games");
  ({ state: s } = tick(s, visit(url, (t += 2000))));
  assert.equal(s.usage.seconds.games, 2);
  assert.deepEqual(s.unknown, {});
});

test("a failed sort is retried after an hour; a sort to an unwatched kind just allows it", () => {
  let s = setSorting(spent({ games: 15 }), true);
  s = { ...s, unknown: { "x.example": { seconds: 60, asking: NOW } } };
  s = sortFailed(s, "x.example", NOW);
  assert.equal(tick(s, visit("https://x.example/", NOW + 60e3)).sort, null);
  assert.equal(tick(s, visit("https://x.example/", NOW + 3600e3 + 1)).sort, "x.example");
  const other = recordSort(s, "x.example", "study");
  assert.equal(decide(other, { url: "https://x.example/", now: NOW }).verdict, "allow");
});

test("the catalog and the user's own sites win over a sorted answer", () => {
  let s = recordSort(spent({ games: 15 }), "youtube.com", "games");
  assert.equal(kindOf(s, YT), "video");
});

test("a state saved by milestone 1 gains the new fields", () => {
  const old = { version: 1, setupDone: true, goal: "", rules: { kinds: {}, sites: {}, dayStart: 4 }, pending: null, usage: { day: null, seconds: {} } };
  const s = upgrade(old);
  assert.equal(s.talk, false);
  assert.deepEqual(s.passes, {});
  assert.equal(s.setupDone, true);
});
