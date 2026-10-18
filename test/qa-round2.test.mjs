// QA round 2 (2026-10-17, ~/gatekeeper-app-qa/round2/RANKED.md), the extension's findings: each exact case.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, setHelp, proposeRules, rollover, decide, tick, enforcement, startExam, examOn, gateRequest,
  applyGateAnswer, recordSort, guardClock, confirmTime, timeCheckNeeded, MAX_JUMP_MS, startWatch, endWatch, watchReady,
  dropLoosen, baseDomain, ruleDomain, cleanRules, todaySummary, noteWithheld, weekSummary,
} from "../extension/engine/engine.js";
import { applyDiff } from "../extension/engine/videos.js";
import { catalogKind } from "../extension/engine/catalog.js";
import { buildRules } from "../extension/hands/blocker.js";

const at = (iso) => new Date(iso).getTime();
const SAT = at("2026-10-17T21:50:00-04:00");
const MON9 = at("2026-10-19T21:00:00-04:00");
const ID = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
const setUp = (kinds, help = true) => {
  const s = { ...completeSetup(initialState(), { kinds, goal: "Finish chapter 3" }, SAT).state, installId: ID };
  return help ? setHelp(s, true) : s;
};
const visit = (s, url, now, seconds = 5) => tick(s, { url, focused: true, active: true, seconds, now }).state;

test("#2 (gate C1): moving the clock forward three days keeps exam mode and the day, until the relay's time says otherwise", () => {
  let s = guardClock(startExam(setUp({ video: 0 }), { until: MON9, goal: "15.425 midterm" }, SAT).state);
  s = rollover(s, SAT + 1000);
  const ahead = SAT + 3 * 86400e3;
  s = visit(s, "https://www.youtube.com/", ahead);
  assert.ok(examOn(s), "exam mode is still on");
  assert.equal(decide(s, { url: "https://www.youtube.com/", now: ahead }).verdict, "block");
  assert.equal(s.usage.day, "2026-10-17", "and the day did not end");
  assert.equal(timeCheckNeeded(s), true, "the hands are asked to check the time");
  // The relay says it is still Saturday evening: from now on the clock is read with that difference.
  s = confirmTime(s, { server: SAT + 60e3, local: ahead });
  assert.equal(timeCheckNeeded(s), false);
  s = visit(s, "https://www.youtube.com/", ahead + 10e3);
  assert.ok(examOn(s));
  assert.ok(s.clock.floor < SAT + 5 * 60e3, "time goes on from the true time");
  assert.equal(startExam(s, { until: SAT + 86400e3 }, ahead + 20e3).refused, undefined, "starting it for the real tomorrow still works");
  // Setting the clock back again: held, checked, and the difference goes away.
  s = rollover(s, SAT + 2 * 60e3);
  assert.equal(timeCheckNeeded(s), true);
  s = confirmTime(s, { server: SAT + 2 * 60e3, local: SAT + 2 * 60e3 });
  assert.equal(s.clock.offset, 0);
  assert.ok(examOn(rollover(s, SAT + 3 * 60e3)));
});

test("#2: a real night asleep counts in full once the relay confirms it; offline, nothing ends", () => {
  let s = guardClock(setUp({ video: 20 }));
  s = visit(s, "https://www.youtube.com/", SAT);
  const morning = at("2026-10-18T09:00:00-04:00");
  s = rollover(s, morning);
  assert.equal(s.usage.day, "2026-10-17", "not yet: the jump is checked first");
  s = confirmTime(s, { server: morning, local: morning });
  s = rollover(s, morning + 2000);
  assert.equal(s.usage.day, "2026-10-18", "the night was real: a new day");
  assert.equal(s.clock.offset, 0);
});

test("#3 (gate C2), Maxime's \"Make it visible\": each period of withheld site access is kept, and the week shows it", () => {
  let s = setUp({ video: 0 });
  s = noteWithheld(s, ["youtube.com", "youtu.be"], SAT);
  assert.deepEqual(s.withheld, { domains: ["youtu.be", "youtube.com"], from: SAT });
  assert.equal(noteWithheld(s, ["youtube.com", "youtu.be"], SAT + 60e3).log.filter((e) => e.type === "access.withheld").length, 0, "still the same period");
  s = noteWithheld(s, [], SAT + 2 * 3600e3);
  assert.equal(s.withheld, null);
  const e = s.log.filter((x) => x.type === "access.withheld");
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].domains, e[0].minutes], [["youtu.be", "youtube.com"], 120]);
  const w = weekSummary(s, SAT + 2 * 3600e3);
  assert.deepEqual(w.withheld, { minutes: 120, domains: ["youtu.be", "youtube.com"] });
  // What still blocks without that access is kept: a watched domain Gatekeeper can't see stays in the block list.
  assert.ok(enforcement(s, SAT, { withheld: ["youtube.com"] }).block.includes("youtube.com"));
});

test("#4 (gate C4): a rule on a parent domain is judged by the catalog sites under it, and public suffixes are refused", () => {
  const s = setUp({ news: 0 });
  for (const rules of [{ sites: { "ycombinator.com": "games" } }, { sites: { "google.com": "games" } }, { siteLimits: { "google.com": 30 } }, { siteLimits: { "ycombinator.com": null } }]) {
    const r = proposeRules(s, { ...s.rules, ...rules }, SAT);
    // A limit of the site's own inside a kind only adds to it, and null leaves the site to its kind (#13), so those
    // may apply now; moving a parent to another kind waits. Either way the closed catalog sites stay closed.
    if (rules.sites) assert.deepEqual(r.now, [], JSON.stringify(rules) + " does not apply now");
    assert.equal(decide(r.state, { url: "https://news.ycombinator.com/", now: SAT }).verdict, "block", JSON.stringify(rules));
    assert.equal(decide(r.state, { url: "https://news.google.com/", now: SAT }).verdict, "block", JSON.stringify(rules));
  }
  assert.equal(ruleDomain("co.uk"), null);
  assert.equal(ruleDomain("github.io"), null);
  assert.equal(ruleDomain("www.lequipe.fr"), "lequipe.fr");
  assert.deepEqual(cleanRules({ siteLimits: { "co.uk": null }, sites: { "github.io": "games" } }, { dayStart: 4 }).siteLimits, {});
  assert.equal(applyDiff({}, [{ op: "siteLimit", domain: "co.uk", minutes: null }]).skipped.length, 1);
  // A parent with a limit that only tightens everything under it still applies now.
  assert.equal(proposeRules(s, { ...s.rules, siteLimits: { "ycombinator.com": 0 } }, SAT).now.length, 1);
});

test("#8 (gate H2): the agent out of reach, the cap, or Claude help off never loosens", async () => {
  // Covered case by case in loosen.test.mjs; here the cap's own words.
  const { loosenUnavailable } = await import("../extension/engine/engine.js");
  const s = setUp({ video: 15 });
  const r = proposeRules(s, { ...s.rules, kinds: { video: { minutes: 120 } } }, SAT);
  const u = loosenUnavailable(r.state, { message: "reason", error: "daily_limit", now: SAT }).state;
  assert.match(u.thread.turns.at(-1).text, /answered enough for today.*keeps waiting/);
  assert.equal(rollover(u, at("2026-10-18T04:01:00-04:00")).rules.kinds.video.minutes, 15);
});

test("#10 (gate H4): exam mode closes everything but study, sites not sorted yet included", () => {
  let s = startExam(setUp({}), { until: MON9 }, SAT).state;
  for (const [d, k] of [["game2.localhost", "games"], ["wikipedia.org", "other"], ["discord.com", "other"], ["notion.so", "work"]]) s = recordSort(s, d, k);
  for (const u of ["https://game2.localhost/", "https://wikipedia.org/", "https://discord.com/", "https://notion.so/", "https://amazon.fr/", "https://never-seen.example/"]) {
    assert.equal(decide(s, { url: u, now: SAT }).verdict, "block", u);
  }
  assert.equal(decide(s, { url: "https://never-seen.example/", now: SAT }).unsorted, true);
  s = recordSort(s, "lecturenotes.example", "study");
  assert.equal(decide(s, { url: "https://lecturenotes.example/courses", now: SAT }).verdict, "allow");
  // With access to every site, every page goes to the gate before it loads, except study sites.
  const e = enforcement(s, SAT, { seeAll: true });
  assert.ok(e.examAll.allow.includes("lecturenotes.example") && e.examAll.allow.includes("instructure.com"));
  const rules = buildRules(e, "chrome-extension://x/pages/gate.html");
  assert.ok(rules.some((r) => r.priority === 1 && r.action.type === "redirect" && r.condition.regexFilter === "^https?://.*"));
  assert.ok(rules.some((r) => r.priority === 3 && r.action.type === "allow" && r.condition.requestDomains && r.condition.requestDomains.includes("lecturenotes.example")));
  assert.equal(enforcement(s, SAT, { seeAll: false }).examAll, null, "without that access it cannot see unknown sites");
  // The gate for an unknown site in exam mode asks the relay as kind "site", budget 0.
  const g = gateRequest(s, { url: "https://wikipedia.org/wiki/NPV", message: "NPV definition for the midterm", now: SAT }).payload;
  assert.deepEqual([g.kind, g.site, g.budget], ["site", "wikipedia.org", 0]);
});

test("#13 (chat H3): \"less instagram\" counts against Social too, so total social time never grows", () => {
  let s = setUp({ social: 30 });
  const r = proposeRules(s, { ...s.rules, siteLimits: { "instagram.com": 15 } }, SAT);
  assert.equal(r.now.length, 1);
  s = r.state;
  for (let i = 0; i < 360; i++) s = visit(s, "https://www.reddit.com/", SAT + i * 5000);
  assert.equal(decide(s, { url: "https://www.reddit.com/", now: SAT }).verdict, "gate", "Social's 30 minutes are spent");
  assert.equal(decide(s, { url: "https://www.instagram.com/", now: SAT }).verdict, "gate", "and instagram with them");
  assert.equal(todaySummary(s, SAT + 1800e3).kinds[0].left, 0);
});

test("#14 (gate H1): a site's own limit never gives a fresh ladder of passes or skips the cooldown", () => {
  let s = setUp({ video: 0 });
  s = applyGateAnswer(s, { url: "https://www.youtube.com/", answer: { decision: "allow", minutes: 10, reply: "ok" }, now: SAT }).state;
  for (let i = 0; i < 125; i++) s = visit(s, "https://example.org/", SAT + i * 5000); // the pass runs out; the cooldown doesn't
  const T = SAT + 11 * 60e3;
  s = proposeRules(s, { ...s.rules, siteLimits: { "youtube.com": 0 } }, T).state;
  assert.equal(decide(s, { url: "https://www.youtube.com/", now: T }).verdict, "block");
  assert.equal(gateRequest(s, { url: "https://www.youtube.com/", message: "again", now: T }).refused, "cooldown");
  s = proposeRules(s, { ...s.rules, siteLimits: { ...s.rules.siteLimits, "m.youtube.com": 0, "music.youtube.com": 0 } }, SAT).state;
  for (const u of ["https://m.youtube.com/", "https://music.youtube.com/", "https://www.netflix.com/"]) {
    assert.equal(gateRequest(s, { url: u, message: "again", now: T }).refused, "cooldown", u);
  }
  // Outside the catalog, subdomains share their base domain's ladder.
  assert.equal(baseDomain("m.lequipe.fr"), "lequipe.fr");
  assert.equal(baseDomain("news.bbc.co.uk"), "bbc.co.uk");
  let t = proposeRules(setUp({}), { ...setUp({}).rules, siteLimits: { "lequipe.fr": 0, "m.lequipe.fr": 0 } }, SAT).state;
  t = applyGateAnswer(t, { url: "https://lequipe.fr/", answer: { decision: "allow", minutes: 10, reply: "ok" }, now: SAT }).state;
  assert.equal(gateRequest(t, { url: "https://m.lequipe.fr/", message: "again", now: SAT + 60e3 }).refused, "cooldown");
});

test("#16 (first-run H3): one stray tap on − is undone from the rules page within a minute, without the agent", () => {
  const s = setUp({ video: 5 });
  const closed = proposeRules(s, { ...s.rules, kinds: { video: { minutes: 0 } } }, SAT, { undoable: true });
  assert.equal(closed.state.rules.kinds.video.minutes, 0, "closed at once, as intended");
  const back = proposeRules(closed.state, { ...closed.state.rules, kinds: { video: { minutes: 5 } } }, SAT + 20e3, { undoable: true });
  assert.equal(back.state.rules.kinds.video.minutes, 5, "the + within a minute undoes it now");
  assert.equal(back.needsOk, undefined);
  const late = proposeRules(closed.state, { ...closed.state.rules, kinds: { video: { minutes: 5 } } }, SAT + 61e3, { undoable: true });
  assert.equal(late.state.rules.kinds.video.minutes, 0, "after a minute, it is a loosening like any other");
  assert.equal(late.needsOk, true);
  const further = proposeRules(closed.state, { ...closed.state.rules, kinds: { video: { minutes: 30 } } }, SAT + 20e3, { undoable: true });
  assert.equal(further.state.rules.kinds.video.minutes, 5, "undo goes back to before the tap, no further");
  assert.equal(further.needsOk, true);
});

test("#17 (first-run H1, H2): the watch week's toolbar count is the minutes so far, and ending it early leaves nothing \"ready\"", () => {
  let s = startWatch(setUp({}, false), { goal: "x" }, SAT);
  s = visit(s, "https://www.reddit.com/", SAT, 5);
  const d = decide(s, { url: "https://www.reddit.com/", now: SAT });
  assert.equal(d.watching, true);
  assert.equal(d.usedMinutes, 0);
  const ended = completeSetup(s, { kinds: { social: 20 }, goal: "x" }, SAT + 86400e3).state;
  assert.equal(watchReady(ended), false, "limits set: the week is not offered as ready");
  assert.equal(watchReady(endWatch(s, SAT + 86400e3)), false, "skipped: not offered either");
});

test("#18 (gate H5): youtube-nocookie.com embeds count as Video", () => {
  assert.equal(catalogKind("www.youtube-nocookie.com"), "video");
  const s = setUp({ video: 0 });
  assert.ok(enforcement(s, SAT).block.includes("youtube-nocookie.com"));
});

test("#5 (chat C1): a loosening's reason can be dropped, and nothing loosens", () => {
  const s = setUp({ video: 15 });
  const r = proposeRules(s, { ...s.rules, kinds: { video: { minutes: 30 } } }, SAT);
  assert.equal(r.state.loosen.kind, "rules");
  const d = dropLoosen(r.state, SAT);
  assert.equal(d.loosen, null);
  assert.equal(d.pending, null);
  assert.equal(rollover(d, at("2026-10-18T04:01:00-04:00")).rules.kinds.video.minutes, 15);
});
