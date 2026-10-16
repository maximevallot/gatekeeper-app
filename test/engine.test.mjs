// node --test   (run with TZ=America/New_York; package.json's test script sets it)
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, decide, tick, proposeRules, rollover, closedKinds, closedDomains,
  kindOf, dayKey, nextDayStart, setGoal,
} from "../extension/engine/engine.js";
import { catalogKind } from "../extension/engine/catalog.js";

const at = (iso) => new Date(iso).getTime();
const MON_2PM = at("2026-10-19T14:00:00-04:00");
const visit = (url, extra = {}) => ({ url, title: "", focused: true, active: true, seconds: 2, ...extra });

function setUp(kinds = { games: 15, social: 15 }, now = MON_2PM) {
  return completeSetup(initialState(), { kinds, goal: "Finish problem set 4" }, now).state;
}

// Feed `minutes` of ticks on `url`, two seconds apart, starting at `now`.
function play(state, url, minutes, now, extra = {}) {
  let s = state, d, t = now;
  for (let i = 0; i < (minutes * 60) / 2; i++) {
    ({ state: s, decision: d } = tick(s, { ...visit(url, extra), now: t }));
    t += 2000;
  }
  return { state: s, decision: d, now: t };
}

test("agar.io is counted as a game, though no rule names it", () => {
  assert.equal(catalogKind("agar.io"), "games");
  assert.equal(catalogKind("www.openfront.io"), "games");
  const s = setUp({ games: 15 });
  const { state } = play(s, "https://agar.io/", 1, MON_2PM);
  assert.equal(state.usage.seconds.games, 60);
});

test("the catalog matches whole domains only", () => {
  assert.equal(catalogKind("m.youtube.com"), "video");
  assert.equal(catalogKind("youtube.com.evil.io"), null);
  assert.equal(catalogKind("notreddit.com"), null);
  assert.equal(catalogKind("news.ycombinator.com"), "news");
  assert.equal(catalogKind("ycombinator.com"), null);
});

test("an unknown site is allowed and never counted", () => {
  const s = setUp();
  const { state, decision } = play(s, "https://some-new-site.dev/", 1, MON_2PM);
  assert.equal(decision.verdict, "allow");
  assert.deepEqual(state.usage.seconds, {});
});

test("time counts only while the tab and window are focused and the user is active", () => {
  const s = setUp();
  assert.equal(play(s, "https://agar.io/", 1, MON_2PM, { focused: false }).state.usage.seconds.games, undefined);
  assert.equal(play(s, "https://agar.io/", 1, MON_2PM, { active: false }).state.usage.seconds.games, undefined);
  // One report never counts more than five seconds, so a laptop waking from sleep costs nothing.
  const { state } = tick(s, { ...visit("https://agar.io/"), seconds: 3600, now: MON_2PM });
  assert.equal(state.usage.seconds.games, 5);
});

test("a spent budget closes the kind until the next morning", () => {
  const s = setUp({ games: 15 });
  const r = play(s, "https://agar.io/", 15, MON_2PM);
  assert.equal(r.decision.verdict, "gate");
  assert.equal(r.decision.usedMinutes, 15);
  assert.equal(r.decision.reopensAt, at("2026-10-20T04:00:00-04:00"));
  // Every game is closed, not only the one played.
  assert.equal(decide(r.state, { url: "https://slither.io/", now: r.now }).verdict, "gate");
  assert.deepEqual(closedKinds(r.state, r.now), ["games"]);
  assert.ok(closedDomains(r.state, r.now).includes("openfront.io"));
  // Gated time is not counted.
  assert.equal(tick(r.state, { ...visit("https://agar.io/"), now: r.now }).state.usage.seconds.games, 900);
  // At 4:00 the next day it opens again.
  const tomorrow = at("2026-10-20T04:00:01-04:00");
  assert.equal(decide(r.state, { url: "https://agar.io/", now: tomorrow }).verdict, "allow");
  assert.deepEqual(rollover(r.state, tomorrow).usage.seconds, {});
});

test("0 minutes blocks a kind outright", () => {
  const s = setUp({ news: 0 });
  assert.equal(decide(s, { url: "https://www.nytimes.com/", now: MON_2PM }).verdict, "block");
  assert.deepEqual(closedKinds(s, MON_2PM), ["news"]);
});

test("tightening applies at once", () => {
  const s = setUp({ games: 15 });
  const r = proposeRules(s, { ...s.rules, kinds: { games: { minutes: 5 }, video: { minutes: 20 } } }, MON_2PM);
  assert.equal(r.state.rules.kinds.games.minutes, 5);
  assert.equal(r.state.rules.kinds.video.minutes, 20);
  assert.equal(r.state.pending, null);
  assert.equal(r.later.length, 0);
});

test("loosening waits until the next morning, and can be cancelled", () => {
  const s = setUp({ games: 15, social: 15 });
  const r = proposeRules(s, { ...s.rules, kinds: { games: { minutes: 60 } } }, at("2026-10-19T23:05:00-04:00"));
  assert.equal(r.state.rules.kinds.games.minutes, 15, "tonight stays at 15");
  assert.ok(r.state.rules.kinds.social, "dropping a kind waits too");
  assert.equal(r.from, at("2026-10-20T04:00:00-04:00"));
  assert.deepEqual(r.later.map((c) => c.text).sort(), ["Games: 15 min a day → 60 min a day", "Social media: no longer watched"]);
  // Still 15 at 3:59, 60 at 4:00.
  assert.equal(rollover(r.state, at("2026-10-20T03:59:00-04:00")).rules.kinds.games.minutes, 15);
  const morning = rollover(r.state, at("2026-10-20T04:00:00-04:00"));
  assert.equal(morning.rules.kinds.games.minutes, 60);
  assert.equal(morning.rules.kinds.social, undefined);
  assert.equal(morning.pending, null);
  // Asking for the rules in force cancels what was waiting.
  const cancel = proposeRules(r.state, r.state.rules, at("2026-10-19T23:10:00-04:00"));
  assert.equal(cancel.state.pending, null);
});

test("a mixed change splits: the tighter part now, the looser part tomorrow", () => {
  const s = setUp({ games: 15, video: 30 });
  const r = proposeRules(s, { ...s.rules, kinds: { games: { minutes: 30 }, video: { minutes: 10 } } }, MON_2PM);
  assert.equal(r.state.rules.kinds.video.minutes, 10);
  assert.equal(r.state.rules.kinds.games.minutes, 15);
  assert.equal(r.state.pending.rules.kinds.games.minutes, 30);
});

test("a site the user adds counts against its kind at once; removing it waits", () => {
  const s = setUp({ games: 15 });
  const r = proposeRules(s, { ...s.rules, sites: { "mygame.example": "games" } }, MON_2PM);
  assert.equal(kindOf(r.state, "https://play.mygame.example/"), "games");
  const back = proposeRules(r.state, { ...r.state.rules, sites: {} }, MON_2PM);
  assert.equal(kindOf(back.state, "https://mygame.example/"), "games");
  assert.ok(back.state.pending);
});

test("the welcome answers become the first rules and the goal", () => {
  const r = completeSetup(initialState(), { kinds: { games: 15, social: "20" }, goal: "  Pass the midterm  " }, MON_2PM);
  assert.equal(r.state.setupDone, true);
  assert.equal(r.state.goal, "Pass the midterm");
  assert.deepEqual(r.state.rules.kinds, { games: { minutes: 15 }, social: { minutes: 20 } });
  assert.equal(r.later.length, 0);
  assert.equal(setGoal(r.state, "New goal").goal, "New goal");
});

test("the day turns at 4:00 local time", () => {
  assert.equal(dayKey(at("2026-10-20T03:59:00-04:00")), "2026-10-19");
  assert.equal(dayKey(at("2026-10-20T04:00:00-04:00")), "2026-10-20");
  assert.equal(nextDayStart(at("2026-10-20T03:00:00-04:00")), at("2026-10-20T04:00:00-04:00"));
});
