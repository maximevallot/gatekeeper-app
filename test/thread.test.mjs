// One thread with Gatekeeper, kept by the engine (one-model plan, gap 3).
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, setHelp, addTurn, recordChatAnswer, chatPreview, chatRequest, applyCard, dropCard, forgetThread,
  applyGateAnswer, applyLoosenAnswer, proposeRules, MAX_TURNS,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T20:00:00-04:00");
const setUp = () => setHelp({ ...completeSetup(initialState(), { kinds: { video: 20, social: 15 }, goal: "Midterm" }, MON).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" }, true);
const answer = (diff, reply = "Here's the change.") => ({ reply, diff });
function say(s, text, ans, now = MON) {
  s = addTurn(s, "user", text, now);
  return recordChatAnswer(s, ans, chatPreview(s, ans, now), now);
}

test("the thread keeps the turns and the open card, and the chat is sent its last six turns", () => {
  let s = say(setUp(), "less social media", answer([{ op: "budget", kind: "social", minutes: 5 }]));
  assert.deepEqual(s.thread.turns.map((t) => [t.role, t.text]), [["user", "less social media"], ["gatekeeper", "Here's the change."]]);
  assert.deepEqual(s.thread.card.view.now, ["Social media: 15 min a day → 5 min a day"]);
  for (let i = 0; i < 10; i++) s = addTurn(s, i % 2 ? "gatekeeper" : "user", "turn " + i, MON);
  const h = chatRequest(s, { message: "next", now: MON }).payload.history;
  assert.equal(h.length, 6);
  assert.equal(h.at(-1).text, "turn 9");
  for (let i = 0; i < 60; i++) s = addTurn(s, "user", "x", MON);
  assert.equal(s.thread.turns.length, MAX_TURNS);
});

test("Apply works from any view, applies the card, and says so in the thread", () => {
  const s = say(setUp(), "less social media", answer([{ op: "budget", kind: "social", minutes: 5 }]));
  const a = applyCard(s, MON + 60e3);
  assert.equal(a.state.rules.kinds.social.minutes, 5);
  assert.equal(a.state.thread.card, null);
  assert.equal(a.state.thread.turns.at(-1).text, "Done. It applies now.");
  assert.equal(applyCard(a.state, MON).refused, "no_card");
});

test("Apply checks the card again: a loosening the agent refused since then is not applied", () => {
  let s = say(setUp(), "more video", answer([{ op: "budget", kind: "video", minutes: 45 }]));
  // Meanwhile, from the rules page: the same loosening asked and refused.
  let r = proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, video: { minutes: 45 } } }, MON);
  r = applyLoosenAnswer(r.state, { answer: { decision: "deny", reply: "No." }, message: "more", now: MON });
  const a = applyCard({ ...r.state, thread: s.thread }, MON + 60e3);
  assert.equal(a.outcome.refused, "asked_today");
  assert.equal(a.state.rules.kinds.video.minutes, 20);
  assert.match(a.state.thread.turns.at(-1).text, /said no to a loosening today/);
});

test("Not this drops the card; Forget this talk clears the thread", () => {
  const s = say(setUp(), "less social", answer([{ op: "budget", kind: "social", minutes: 5 }]));
  const d = dropCard(s, MON);
  assert.equal(d.thread.card, null);
  assert.equal(d.rules.kinds.social.minutes, 15);
  assert.equal(d.thread.turns.at(-1).text, "Nothing changed.");
  assert.deepEqual(forgetThread(d).thread, { turns: [], card: null });
});

test("the gate's outcome and the agent's answers on loosening show in the thread", () => {
  let s = { ...setUp(), usage: { ...setUp().usage, seconds: { video: 1200 } } };
  s = applyGateAnswer(s, { url: "https://www.youtube.com/watch?v=a", answer: { decision: "allow", minutes: 5, reply: "ok" }, now: MON }).state;
  assert.equal(s.thread.turns.at(-1).text, "The gate gave 5 min on youtube.com.");
  let r = proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, social: { minutes: 30 } } }, MON);
  s = applyLoosenAnswer(r.state, { answer: { decision: "allow", reply: "OK from tomorrow." }, message: "Group project chat", now: MON }).state;
  assert.deepEqual(s.thread.turns.slice(-2).map((t) => [t.role, t.text]), [["user", "Group project chat"], ["gatekeeper", "OK from tomorrow."]]);
});
