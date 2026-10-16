// Regression tests for the QA findings of 2026-10-16 (~/gatekeeper-app-qa/findings.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, decide, tick, proposeRules, rollover, enforcement, setTalk, applyGateAnswer,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const NOW = at("2026-10-19T14:00:00-04:00");
const YT = "https://www.youtube.com/watch?v=abc";
const visit = (url, now, extra = {}) => ({ url, title: "", focused: true, active: true, seconds: 2, now, ...extra });
const setUp = (kinds, now = NOW) => completeSetup(initialState(), { kinds, goal: "Finish problem set 4" }, now).state;
function play(s, url, minutes, now, extra = {}) {
  let t = now;
  for (let i = 0; i < (minutes * 60) / 2; i++) ({ state: s } = tick(s, { ...visit(url, t, extra) })), (t += 2000);
  return { state: s, now: t };
}

test("C1: moving a closed site to an unwatched kind waits for the morning", () => {
  const s = setUp({ video: 0 });
  const r = proposeRules(s, { ...s.rules, sites: { "youtube.com": "shopping" } }, NOW);
  assert.equal(decide(r.state, { url: YT, now: NOW }).verdict, "block", "still closed tonight");
  assert.ok(r.later.some((c) => /youtube\.com/.test(c.text)));
  assert.equal(decide(r.state, { url: YT, now: at("2026-10-20T04:00:01-04:00") }).verdict, "allow", "the morning decides");
});

test("C1: moving a spent site to a kind with minutes left waits; to a stricter kind applies now", () => {
  let { state: s, now } = play(setUp({ video: 1, games: 15, news: 0 }), YT, 1, NOW);
  assert.equal(decide(s, { url: YT, now }).verdict, "gate");
  const looser = proposeRules(s, { ...s.rules, sites: { "youtube.com": "games" } }, now);
  assert.equal(decide(looser.state, { url: YT, now }).verdict, "gate");
  const stricter = proposeRules(s, { ...s.rules, sites: { "chess.com": "news" } }, now);
  assert.equal(decide(stricter.state, { url: "https://www.chess.com/", now }).verdict, "block", "games → closed news: at once");
  // Undoing a move that was stricter is a loosening and waits; undoing one that was looser is at once.
  const undo = proposeRules(stricter.state, { ...stricter.state.rules, sites: {} }, now);
  assert.equal(decide(undo.state, { url: "https://www.chess.com/", now }).verdict, "block");
});

test("M1: rules from the console are cleaned: no NaN minutes, no unknown kinds", () => {
  const s = setUp({ video: 0 });
  const r = proposeRules(s, { kinds: { video: {}, nonsense: { minutes: 5 } }, sites: { "x.example": "nope" }, dayStart: 4 }, NOW);
  assert.equal(decide(r.state, { url: YT, now: NOW }).verdict, "block");
  assert.deepEqual(Object.keys(r.state.rules.kinds), ["video"]);
  assert.deepEqual(r.state.rules.sites, {});
});

test("H2: setting the clock back neither restores budget nor stretches a pass", () => {
  let { state: s, now } = play(setUp({ video: 1 }), YT, 1, NOW);
  assert.equal(decide(s, { url: YT, now }).verdict, "gate");
  // The clock goes back an hour, then a day: still today, still spent.
  assert.equal(decide(s, { url: YT, now: now - 3600e3 }).verdict, "gate");
  ({ state: s } = tick(s, visit(YT, now - 86400e3)));
  assert.equal(decide(s, { url: YT, now: now - 86400e3 + 2000 }).verdict, "gate");
  // A 10-minute pass, then the clock goes back an hour: the pass still ends after 10 minutes of ticks.
  s = setTalk(s, true);
  let p = applyGateAnswer(s, { url: YT, answer: { decision: "allow", minutes: 10, reply: "ok" }, now }).state;
  let t = now - 3600e3;
  for (let i = 0; i < 300; i++) ({ state: p } = tick(p, visit("https://example.org/", (t += 2000))));
  assert.equal(decide(p, { url: YT, now: t }).verdict, "gate");
});

test("H2: a waiting loosening never applies on a clock set back, and a timezone change keeps the day", () => {
  const s = setUp({ social: 15 });
  const r = proposeRules(s, { ...s.rules, kinds: { social: { minutes: 120 } } }, at("2026-10-19T23:00:00-04:00"));
  const back = rollover(r.state, at("2026-10-18T23:00:00-04:00"));
  assert.equal(back.rules.kinds.social.minutes, 15);
  // The day ends at a fixed moment: reading it under another timezone's calendar does not end it early.
  let { state: used } = play(setUp({ video: 15 }), YT, 1, NOW);
  const endsAt = used.usage.endsAt;
  assert.equal(endsAt, at("2026-10-20T04:00:00-04:00"));
  assert.equal(rollover(used, endsAt - 1).usage.seconds.video, 60);
  assert.deepEqual(rollover(used, endsAt).usage.seconds, {});
});

test("H3: a watched site playing sound counts in any window, once per kind per tick", () => {
  const s = setUp({ video: 15, social: 15 });
  const { state } = tick(s, visit("https://docs.example/", NOW, { audible: [YT, "https://vimeo.com/1", "https://www.instagram.com/reel/x"] }));
  assert.deepEqual(state.usage.seconds, { video: 2, social: 2 });
  const unfocused = tick(s, visit(YT, NOW, { focused: false, audible: [YT] })).state;
  assert.deepEqual(unfocused.usage.seconds, { video: 2 }, "front and audible are the same kind: counted once");
});

test("C2 and H1: closed sites are blocked in frames too, and a watched site whose access is withheld is blocked", () => {
  const s = setUp({ video: 0, social: 15 });
  const e = enforcement(s, NOW, { withheld: ["instagram.com", "amazon.com"] });
  assert.ok(e.redirect.includes("youtube.com"));
  assert.ok(e.block.includes("youtube.com"), "for embeds and for a withheld YouTube");
  assert.ok(e.block.includes("instagram.com"), "social has time left but cannot be counted there");
  assert.ok(!e.block.includes("amazon.com"), "shopping is not watched");
  assert.deepEqual(e.blind, ["instagram.com"]);
});
