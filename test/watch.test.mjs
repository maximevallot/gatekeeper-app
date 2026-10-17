// The watch-only first week (2026-10-17): count every kind for 7 days, block nothing, then a baseline.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, startWatch, endWatch, watching, watchReady, markWatchShown, completeSetup, decide, tick,
  closedDomains, enforcement, baseline, todaySummary, weekSummary,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T14:00:00-04:00");
const visit = (url, now) => ({ url, title: "", focused: true, active: true, seconds: 2, now });
function play(s, url, minutes, now) {
  let t = now;
  for (let i = 0; i < (minutes * 60) / 2; i++) ({ state: s } = tick(s, visit(url, t))), (t += 2000);
  return s;
}

test("the watch week counts every kind and blocks nothing, for seven days", () => {
  let s = startWatch(initialState(), { goal: "Finish problem set 4" }, MON);
  assert.ok(s.setupDone && watching(s));
  assert.equal(s.watch.until, at("2026-10-26T04:00:00-04:00"));
  s = play(s, "https://www.youtube.com/watch?v=x", 30, MON);
  s = play(s, "https://www.instagram.com/", 10, MON + 3600e3);
  assert.equal(decide(s, { url: "https://www.youtube.com/", now: MON + 7200e3 }).verdict, "allow");
  assert.deepEqual(closedDomains(s, MON + 7200e3), []);
  assert.deepEqual(enforcement(s, MON + 7200e3, { withheld: ["youtube.com"] }).block, []);
  assert.equal(s.usage.seconds.video, 1800);
  assert.equal(s.usage.seconds.social, 600);
  const t = todaySummary(s, MON + 7200e3);
  assert.equal(t.watch.day, 1);
  assert.equal(t.watch.kinds.find((k) => k.kind === "video").used, 30);
});

test("after the week: a baseline per kind, with a starting limit at half, and the summary shown once", () => {
  let s = startWatch(initialState(), {}, MON);
  for (let d = 0; d < 7; d++) s = play(s, "https://www.youtube.com/watch?v=x", 40, MON + d * 86400e3);
  const after = at("2026-10-26T09:00:00-04:00");
  s = tick(s, visit("https://example.org/", after)).state;
  assert.ok(!watching(s));
  assert.ok(watchReady(s));
  const b = baseline(s, after);
  assert.equal(b.days, 7);
  assert.deepEqual(b.kinds, [{ kind: "video", label: "Video", perDay: 40, suggested: 20 }]);
  assert.ok(!watchReady(markWatchShown(s)));
  assert.equal(weekSummary(s, after).days.filter((d) => d.watching).length, 6, "the week's chart marks the watching days");
});

test("one tap skips the rest of the week, and setting rules ends it too", () => {
  let s = startWatch(initialState(), {}, MON);
  s = endWatch(s, MON + 60e3);
  assert.ok(!watching(s));
  let w = startWatch(initialState(), {}, MON);
  w = completeSetup(w, { kinds: { video: 0 }, goal: "" }, MON + 60e3).state;
  assert.ok(!watching(w));
  assert.equal(decide(w, { url: "https://www.youtube.com/", now: MON + 120e3 }).verdict, "block");
});

test("the clock set forward does not end the watch week early for nothing: the floor keeps time honest", () => {
  let s = startWatch(initialState(), {}, MON);
  assert.ok(watching(tick(s, visit("https://example.org/", MON + 3 * 86400e3)).state));
});
