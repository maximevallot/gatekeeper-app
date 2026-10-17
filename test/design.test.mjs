// The simplified design (2026-10-17): one "Claude help" consent, the week's history, and today's summary.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, upgrade, completeSetup, tick, consented, consentStatus, setHelp, setTalk, gateRequest, chatRequest,
  noteGate, weekSummary, todaySummary, CONSENT, WHATS_SENT,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const NOW = at("2026-10-19T14:00:00-04:00");
const YT = "https://www.youtube.com/watch?v=abc";
const visit = (url, now) => ({ url, title: "", focused: true, active: true, seconds: 2, now });
const setUp = (kinds) => ({ ...completeSetup(initialState(), { kinds, goal: "Finish problem set 4" }, NOW).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" });
function play(s, url, minutes, now) {
  let t = now;
  for (let i = 0; i < (minutes * 60) / 2; i++) ({ state: s } = tick(s, visit(url, t))), (t += 2000);
  return { state: s, now: t };
}

test("one Claude help yes covers the gate, the chat, video judging, and sorting when the browser allows it", () => {
  let s = setUp({ video: 0 });
  assert.equal(gateRequest(s, { url: YT, message: "lecture", now: NOW }).refused, "no_consent");
  s = setHelp(s, true, { sorting: false });
  for (const name of ["talk", "chat", "judge", "sorting"]) assert.ok(consented(s, name), name);
  assert.equal(s.sorting, false, "no all-sites permission: sorting stays off");
  assert.ok(gateRequest(s, { url: YT, message: "lecture", now: NOW }).payload);
  assert.ok(chatRequest(s, { message: "less social", now: NOW }).payload);
  assert.equal(setHelp(s, true, { sorting: true }).sorting, true);
});

test("turning Claude help off withdraws every yes, the old per-feature ones too", () => {
  let s = setTalk(setUp({ video: 0 }), true);
  assert.ok(consented(s, "talk"), "a yes from before the single switch still counts");
  s = setHelp(s, false);
  for (const name of ["talk", "chat", "judge", "sorting", "help"]) assert.ok(!consented(s, name), name);
  assert.equal(s.talk, false);
  assert.equal(gateRequest(s, { url: YT, message: "lecture", now: NOW }).refused, "no_consent");
});

test("a new Claude help text asks again: a yes to an older version is not a yes", () => {
  const s = { ...setUp({}), consent: { help: CONSENT.help - 0.5 } };
  assert.ok(!consented(s, "talk"));
  assert.deepEqual(consentStatus(s).help, { on: false, outdated: true });
});

test("the list of what is sent names every field the requests carry", () => {
  const text = JSON.stringify(WHATS_SENT).toLowerCase();
  for (const word of ["site", "kind", "minutes", "budget", "goal", "type", "title", "channel", "rules", "date"]) assert.ok(text.includes(word), word);
});

test("the week keeps one line per finished day, and today live", () => {
  let { state: s, now } = play(setUp({ video: 20, social: 15 }), YT, 10, NOW);
  s = noteGate(s, now);
  // Two days later, the history has Monday; Tuesday was not lived (no record), Wednesday is today.
  const wed = at("2026-10-21T10:00:00-04:00");
  ({ state: s } = tick(s, visit(YT, wed)));
  const w = weekSummary(s, wed);
  assert.equal(w.days.length, 7);
  assert.equal(w.days[6].day, "2026-10-21");
  const mon = w.days.find((d) => d.day === "2026-10-19");
  assert.equal(mon.minutes, 10);
  assert.equal(mon.allowed, 35);
  assert.equal(mon.gates, 1);
  assert.ok(w.days.find((d) => d.day === "2026-10-20").none || w.days.find((d) => d.day === "2026-10-20").minutes === 0);
  assert.equal(w.gates, 1);
  assert.ok(w.days[0].none, "before Gatekeeper kept history: no made-up numbers");
});

test("the week's history survives the version-1 upgrade and is capped", () => {
  const s = upgrade({ version: 2, rules: { kinds: {}, sites: {}, dayStart: 4 }, usage: { day: "2026-10-19", endsAt: at("2026-10-20T04:00:00-04:00"), seconds: {}, passes: {} } });
  assert.deepEqual(s.history, []);
});

test("today shows each watched kind: minutes left, spent until the morning, or closed all day", () => {
  let { state: s, now } = play(setUp({ social: 15, video: 1, games: 0 }), YT, 1, NOW);
  ({ state: s } = tick(s, visit("https://www.instagram.com/", now)));
  const t = todaySummary(s, now);
  const by = Object.fromEntries(t.kinds.map((k) => [k.kind, k]));
  assert.deepEqual(t.kinds.map((k) => k.kind), ["social", "video", "games"]);
  assert.equal(by.social.status, "open");
  assert.equal(by.social.left, 15);
  assert.equal(by.social.short, "Social");
  assert.equal(by.video.status, "spent");
  assert.equal(by.games.status, "closed");
  assert.equal(t.goal, "Finish problem set 4");
  assert.equal(t.reopensAt, at("2026-10-20T04:00:00-04:00"));
});
