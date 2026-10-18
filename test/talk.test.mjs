// Milestone 2 in the engine: the gate's request and answer, passes, and sorting unknown sites.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, upgrade, completeSetup, decide, tick, closedDomains, gateRequest, applyGateAnswer,
  recordSort, sortFailed, setTalk, setSorting, kindOf, COOLDOWN_MS, AFTER_PASS_MS,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const NOW = at("2026-10-19T21:40:00-04:00");
const YT = "https://www.youtube.com/watch?v=abc";
const visit = (url, now, extra = {}) => ({ url, title: "", focused: true, active: true, seconds: 2, now, ...extra });
const allow = (minutes) => ({ decision: "allow", minutes, reply: "ok" });

function spent(kinds = { video: 20 }) {
  let s = completeSetup(initialState(), { kinds, goal: "Finish problem set 4" }, NOW).state;
  return { ...s, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", usage: { ...s.usage, seconds: { video: 20 * 60 } } };
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
    kind: "video", minutesUsed: 20, budget: 20, deadlines: [], message: "I need the lecture 6 recording", exam: null, now: "2026-10-19T21:40:00-04:00",
  });
  assert.deepEqual(gateRequest(s, { url: YT, message: "   ", now: NOW }), { refused: "empty" });
  assert.equal(gateRequest(s, { url: YT, message: "x".repeat(900), now: NOW }).payload.message.length, 500);
  assert.deepEqual(gateRequest(setTalk(spent({ video: 60 }), true), { url: YT, message: "hi", now: NOW }), { refused: "open" });
});

test("allow opens the one site asked for, for minutes the ticks use up, then the gate comes back", () => {
  const s = setTalk(spent(), true);
  const { state, result } = applyGateAnswer(s, { url: YT, answer: allow(5), now: NOW });
  assert.equal(result.decision, "allow");
  assert.equal(result.minutes, 5);
  assert.equal(result.site, "youtube.com");
  assert.equal(decide(state, { url: "https://m.youtube.com/watch", now: NOW }).verdict, "allow");
  assert.equal(decide(state, { url: "https://vimeo.com/1", now: NOW }).verdict, "gate", "H4: not every video site");
  assert.ok(!closedDomains(state, NOW).includes("youtube.com"));
  assert.ok(closedDomains(state, NOW).includes("vimeo.com"));
  let s2 = state, t = NOW;
  for (let i = 0; i < 149; i++) ({ state: s2 } = tick(s2, visit("https://example.org/", (t += 2000))));
  assert.equal(decide(s2, { url: YT, now: t }).verdict, "allow", "4 min 58 s used");
  ({ state: s2 } = tick(s2, visit("https://example.org/", (t += 2000))));
  assert.equal(decide(s2, { url: YT, now: t }).verdict, "gate");
  assert.ok(closedDomains(s2, t).includes("youtube.com"));
});

test("H4: passes shrink, 10 then 5 then 2 minutes, then none; and the gate rests after each", () => {
  let s = setTalk(spent(), true);
  const got = [];
  let t = NOW;
  for (let i = 0; i < 3; i++) {
    const r = applyGateAnswer(s, { url: YT, answer: allow(30), now: t });
    got.push(r.result.minutes);
    s = r.state;
    assert.equal(gateRequest(s, { url: "https://vimeo.com/", message: "again", now: t + 60e3 }).refused, "cooldown");
    t += r.result.minutes * 60e3 + AFTER_PASS_MS + 1;
    s = { ...s, passes: {} }; // the pass ran out
  }
  assert.deepEqual(got, [10, 5, 2]);
  assert.equal(gateRequest(s, { url: YT, message: "one more", now: t }).refused, "passes_used");
});

test("H4: one follow-up is kept by the engine, not the page", () => {
  const s = setTalk(spent(), true);
  const ask = { decision: "ask", minutes: 0, reply: "Which class?" };
  const first = applyGateAnswer(s, { url: YT, answer: ask, now: NOW });
  assert.equal(first.result.decision, "ask");
  // The answer carries the gate's own question, so the relay decides (tester case, 2026-10-18).
  assert.equal(gateRequest(first.state, { url: YT, message: "econometrics", now: NOW + 10e3 }).payload.asked, "Which class?");
  assert.equal(gateRequest(s, { url: YT, message: "hello", now: NOW }).payload.asked, undefined, "a first message has none");
  // A second question anyway is shown, never a silent no; a third is a no, whatever the page says.
  const second = applyGateAnswer(first.state, { url: YT, answer: ask, now: NOW + 30e3 });
  assert.equal(second.result.decision, "ask");
  const third = applyGateAnswer(second.state, { url: YT, answer: ask, now: NOW + 40e3 });
  assert.equal(third.result.decision, "deny");
  assert.equal(third.state.cooldowns.video, NOW + 40e3 + COOLDOWN_MS);
  const no = applyGateAnswer(s, { url: YT, answer: { decision: "deny", minutes: 0, reply: "No." }, now: NOW });
  assert.equal(gateRequest(no.state, { url: YT, message: "please", now: NOW + 60e3 }).refused, "cooldown");
  assert.ok(gateRequest(no.state, { url: YT, message: "please", now: NOW + COOLDOWN_MS + 1 }).payload);
  for (const bad of [null, {}, { decision: "maybe", reply: "x" }, { decision: "allow" }]) {
    const r = applyGateAnswer(s, { url: YT, answer: bad, now: NOW });
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
  s = recordSort(s, "paper-io.example", "games");
  assert.equal(kindOf(s, "https://www.paper-io.example/"), "games");
  ({ state: s } = tick(s, visit(url, (t += 2000))));
  assert.equal(s.usage.seconds.games, 2);
  assert.deepEqual(s.unknown, {});
});

test("a failed sort is retried after an hour; a sort to an unwatched kind just allows it", () => {
  let s = setSorting(spent({ games: 15 }), true);
  s = tick(s, visit("https://example.org/", NOW)).state;
  s = { ...s, unknown: { "x.example": { seconds: 60, asking: NOW } } };
  s = sortFailed(s, "x.example", NOW);
  assert.equal(tick(s, visit("https://x.example/", NOW + 60e3)).sort, null);
  assert.equal(tick(s, visit("https://x.example/", NOW + 3600e3 + 1)).sort, "x.example");
  const other = recordSort(s, "x.example", "study");
  assert.equal(decide(other, { url: "https://x.example/", now: NOW }).verdict, "allow");
});

test("the catalog and the user's own sites win over a sorted answer", () => {
  const s = recordSort(spent({ games: 15 }), "youtube.com", "games");
  assert.equal(kindOf(s, YT), "video");
});

test("a state saved by version 1 keeps today's usage and gains the new fields", () => {
  const old = { version: 1, setupDone: true, goal: "", rules: { kinds: { video: { minutes: 20 } }, sites: {}, dayStart: 4 },
    pending: null, usage: { day: "2026-10-19", seconds: { video: 1200 } }, passes: { video: NOW + 60e3 } };
  const s = upgrade(old);
  assert.equal(s.version, 2);
  assert.equal(s.usage.endsAt, at("2026-10-20T04:00:00-04:00"));
  assert.deepEqual(s.passes, {});
  assert.equal(decide(s, { url: YT, now: NOW }).verdict, "gate", "updating does not hand out a fresh budget");
});
