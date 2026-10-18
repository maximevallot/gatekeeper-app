// A site's own limit (Maxime's correction of 2026-10-17): one site, or a domain and its subdomains, gets its own
// daily minutes (0: closed; null: closed only in exam mode), its own gate, and counts against nothing else. The
// chat names it siteLimit / dropSiteLimit, and the rules carry siteLimits {domain: minutes}, as the relay does.
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, setHelp, chatRequest, chatPreview, recordChatAnswer, applyCard, addTurn, proposeRules,
  decide, tick, enforcement, todaySummary, startExam, gateRequest, applyGateAnswer, describeChanges, recordSort, upgrade,
} from "../extension/engine/engine.js";
import { applyDiff } from "../extension/engine/videos.js";
import { buildRules } from "../extension/hands/blocker.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T14:00:00-04:00");
const LEQUIPE = "https://www.lequipe.fr/Football/";
const ID = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
const setUp = (kinds = { social: 20 }) => setHelp({ ...completeSetup(initialState(), { kinds, goal: "Finish the thesis" }, MON).state, installId: ID }, true);
const run = (s, url, minutes, now = MON) => {
  for (let i = 0; i < minutes * 12; i++) s = tick(s, { url, focused: true, active: true, seconds: 5, now: now + i * 5000 }).state;
  return s;
};
const say = (s, text, answer, now = MON) => {
  s = addTurn(s, "user", text, now);
  const preview = chatPreview(s, answer, now);
  return { state: recordChatAnswer(s, answer, preview, now), preview };
};

test("Maxime's conversation: \"limit lequipe\" is lequipe.fr, 15 min a day, applying now, and news is never asked about", () => {
  // What he typed, and the relay's answer under prompts/rules.md (d3ad251): a site's own limit, never its kind.
  let s = setUp();
  const first = say(s, "i want to put a limit on the site lequipe",
    { reply: "lequipe.fr: 15 minutes a day.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] });
  assert.equal(first.preview.question, null, "no modelling question when a default exists");
  assert.deepEqual(first.preview.now.map((c) => c.text), ["lequipe.fr: 15 min a day"]);
  assert.deepEqual(first.preview.later, []);
  assert.deepEqual(first.state.thread.card.view.now, ["lequipe.fr: 15 min a day"], "the card: lequipe.fr · 15 min a day · applies now");
  const applied = applyCard(first.state, MON);
  s = applied.state;
  assert.equal(s.thread.turns.at(-1).text, "Done. It applies now.");
  assert.deepEqual(s.rules.siteLimits, { "lequipe.fr": 15 });
  assert.equal(s.rules.kinds.news, undefined, "news is not watched because of it");
  assert.equal(s.rules.sites["lequipe.fr"], undefined, "lequipe is not filed under a kind");
  // The next message carries the site's own limit to the relay.
  assert.deepEqual(chatRequest(s, { message: "make it 30", now: MON }).payload.rules.siteLimits, { "lequipe.fr": 15 });
});

test("the bad version he met, then his correction: the correction is a change, not another question", () => {
  // Before: the chat filed lequipe under news and asked whether to watch news. That question changed nothing.
  let s = setUp();
  let r = say(s, "i want to put a limit on the site lequipe",
    { reply: "", question: "lequipe.fr is a news site. Do you want to limit all news, or watch news in exam mode only?", diff: [] });
  assert.equal(r.state.thread.card, null, "a question changes nothing");
  // "no i want a limit on lequipe irrespective of it being news": now a siteLimit, with no question.
  r = say(r.state, "no i want a limit on lequipe irrespective of it being news",
    { reply: "lequipe.fr: 15 minutes a day, apart from news.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] });
  assert.deepEqual(r.state.thread.card.view.now, ["lequipe.fr: 15 min a day"]);
  // The relay sees the whole exchange as history, so "make it 30" can refer back to it.
  const hist = chatRequest(r.state, { message: "make it 30", now: MON }).payload.history.map((h) => h.role);
  assert.deepEqual(hist, ["user", "gatekeeper", "user", "gatekeeper"]);
  s = applyCard(r.state, MON).state;
  // News not watched: its time counts against lequipe.fr only.
  s = recordSort(s, "lequipe.fr", "news");
  let r2 = run(s, LEQUIPE, 3);
  assert.equal(r2.usage.seconds["s:lequipe.fr"], 180);
  assert.equal(r2.usage.seconds.news || 0, 0, "news is not watched, so it counts against nothing else");
  // News watched (QA round 2, H3): inside a watched kind it counts against both, and the smaller wins.
  r2 = run(proposeRules(s, { ...s.rules, kinds: { ...s.rules.kinds, news: { minutes: 30 } } }, MON).state, LEQUIPE, 3);
  assert.equal(r2.usage.seconds["s:lequipe.fr"], 180);
  assert.equal(r2.usage.seconds.news, 180);
  assert.equal(decide(r2, { url: "https://www.nytimes.com/", now: MON }).leftMinutes, 27);
  assert.equal(decide(r2, { url: LEQUIPE, now: MON }).leftMinutes, 12);
});

test("\"make it 30\" and \"only in exam mode\" right after the card replace it and apply now", () => {
  let r = say(setUp(), "i want to put a limit on the site lequipe", { reply: "lequipe.fr: 15 minutes a day.", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] });
  r = say(r.state, "make it 30", { reply: "lequipe.fr: 30 minutes a day.", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 30 }] });
  assert.deepEqual(r.state.thread.card.view.now, ["lequipe.fr: 30 min a day"], "nothing was applied yet, so 30 is still a new limit");
  r = say(r.state, "only in exam mode", { reply: "lequipe.fr: closed only in exam mode.", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: null }] });
  assert.deepEqual(r.state.thread.card.view.now, ["lequipe.fr: closed only in exam mode"]);
  const s = applyCard(r.state, MON).state;
  assert.deepEqual(s.rules.siteLimits, { "lequipe.fr": null });
});

test("once applied, more time is a loosening the agent decides; less applies now", () => {
  let s = applyCard(say(setUp(), "limit lequipe", { reply: "ok", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] }).state, MON).state;
  let r = say(s, "make it 30", { reply: "lequipe.fr: 30 minutes a day.", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 30 }] });
  assert.deepEqual(r.preview.later.map((c) => c.text), ["lequipe.fr: 15 → 30 min a day"]);
  const a = applyCard(r.state, MON);
  assert.equal(a.outcome.needsOk, true, "with Claude help on, the agent holds the key");
  assert.equal(a.state.rules.siteLimits["lequipe.fr"], 15, "still 15 today");
  assert.deepEqual(a.state.loosen.changes, ["lequipe.fr: 15 → 30 min a day"]);
  r = say(s, "only in exam mode", { reply: "ok", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: null }] });
  assert.deepEqual(r.preview.later.map((c) => c.text), ["lequipe.fr: 15 min a day → closed only in exam mode"]);
  r = say(s, "drop it", { reply: "ok", diff: [{ op: "dropSiteLimit", domain: "lequipe.fr" }] });
  assert.deepEqual(r.preview.later.map((c) => c.text), ["lequipe.fr: limit removed"]);
  r = say(s, "make it 5", { reply: "ok", diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 5 }] });
  assert.deepEqual(r.preview.now.map((c) => c.text), ["lequipe.fr: 15 → 5 min a day"]);
});

test("its own gate: open with time left, the gate when spent, closed at 0; the gate is asked as kind \"site\"", () => {
  let s = proposeRules(setUp(), { ...setUp().rules, siteLimits: { "lequipe.fr": 15 } }, MON).state;
  assert.equal(decide(s, { url: LEQUIPE, now: MON }).verdict, "allow");
  s = run(s, LEQUIPE, 15);
  const t = MON + 15 * 60e3;
  const d = decide(s, { url: LEQUIPE, now: t });
  assert.equal(d.verdict, "gate");
  assert.equal(d.site, "lequipe.fr");
  assert.deepEqual(enforcement(s, t).redirect, ["lequipe.fr"]);
  const req = gateRequest(s, { url: LEQUIPE, message: "I need the match report for my stats class", now: t });
  assert.equal(req.payload.kind, "site");
  assert.equal(req.payload.site, "lequipe.fr");
  assert.equal(req.payload.budget, 15);
  const g = applyGateAnswer(s, { url: LEQUIPE, answer: { decision: "allow", minutes: 5, reply: "Five minutes." }, now: t });
  assert.equal(g.result.site, "lequipe.fr");
  assert.equal(decide(g.state, { url: LEQUIPE, now: t }).verdict, "allow");
  assert.deepEqual(enforcement(g.state, t).redirect, [], "the pass opens it");
  const closed = proposeRules(s, { ...s.rules, siteLimits: { "lequipe.fr": 0 } }, t).state;
  assert.equal(decide(closed, { url: LEQUIPE, now: t }).verdict, "block");
});

test("a catalog site closed on its own while its kind is not watched, and a subdomain open inside a closed kind", () => {
  let s = setUp();
  s = proposeRules(s, { ...s.rules, siteLimits: { "nytimes.com": 0 } }, MON).state;
  assert.equal(s.rules.kinds.news, undefined);
  assert.equal(decide(s, { url: "https://www.nytimes.com/", now: MON }).verdict, "block");
  assert.equal(decide(s, { url: "https://www.cnn.com/", now: MON }).verdict, "allow", "the rest of news is untouched");
  assert.deepEqual(enforcement(s, MON).redirect, ["nytimes.com"]);
  // Giving a subdomain of a closed site time of its own would open it today: that waits.
  const r = proposeRules(s, { ...s.rules, siteLimits: { "nytimes.com": 0, "cooking.nytimes.com": 20 } }, MON);
  assert.deepEqual(r.later.map((c) => c.text), ["cooking.nytimes.com: 20 min a day"]);
  // Inside a closed kind, a site's own minutes don't open it: both count (QA round 2, H3).
  const inNews = proposeRules(setUp({ news: 0 }), { ...setUp({ news: 0 }).rules, siteLimits: { "cooking.nytimes.com": 20 } }, MON);
  assert.deepEqual(inNews.now.map((c) => c.text), ["cooking.nytimes.com: 20 min a day"], "a limit inside a kind only tightens, so it applies now");
  assert.equal(decide(inNews.state, { url: "https://cooking.nytimes.com/recipes", now: MON }).verdict, "block");
  // cooking.nytimes.com with its own 20 minutes first, then nytimes.com closed on its own: it stays open, let
  // through above the block.
  s = proposeRules(setUp(), { ...setUp().rules, siteLimits: { "cooking.nytimes.com": 20 } }, MON).state;
  s = proposeRules(s, { ...s.rules, siteLimits: { ...s.rules.siteLimits, "nytimes.com": 0 } }, MON).state;
  assert.equal(s.rules.siteLimits["nytimes.com"], 0);
  assert.equal(decide(s, { url: "https://cooking.nytimes.com/recipes", now: MON }).verdict, "allow");
  assert.equal(decide(s, { url: "https://www.nytimes.com/", now: MON }).verdict, "block");
  const e = enforcement(s, MON);
  assert.ok(e.redirect.includes("nytimes.com"));
  assert.deepEqual(e.allowSites, ["cooking.nytimes.com"]);
  const allow = buildRules(e, "chrome-extension://x/pages/gate.html").find((r) => r.action.type === "allow");
  assert.equal(allow.priority, 3);
  assert.deepEqual(allow.condition.requestDomains, ["cooking.nytimes.com"]);
});

test("adding a limit inside a spent kind only tightens: it applies now, and the kind still closes the site", () => {
  let s = recordSort(setUp({ news: 10 }), "lequipe.fr", "news");
  s = run(s, LEQUIPE, 10);
  const t = MON + 10 * 60e3;
  assert.equal(decide(s, { url: LEQUIPE, now: t }).verdict, "gate");
  const r = proposeRules(s, { ...s.rules, siteLimits: { "lequipe.fr": 15 } }, t);
  assert.deepEqual(r.now.map((c) => c.text), ["lequipe.fr: 15 min a day"]);
  const d = decide(r.state, { url: LEQUIPE, now: t });
  assert.equal(d.verdict, "gate", "fresh minutes of its own don't reopen it: News is spent");
  assert.equal(d.label, "News", "the gate speaks of the kind that closes it");
  assert.equal(gateRequest(r.state, { url: LEQUIPE, message: "need it", now: t }).payload.kind, "news");
});

test("exam mode closes a site's own limit, null (only in exam mode) included; null is open on other days", () => {
  let s = setUp();
  s = proposeRules(s, { ...s.rules, siteLimits: { "lequipe.fr": null, "example.org": 30 } }, MON).state;
  assert.equal(decide(s, { url: LEQUIPE, now: MON }).verdict, "allow");
  assert.equal(decide(s, { url: LEQUIPE, now: MON }).watched, false, "not counted on a normal day");
  assert.ok(!enforcement(s, MON).redirect.includes("lequipe.fr"));
  const ex = startExam(s, { until: MON + 4 * 3600e3, goal: "midterm" }, MON).state;
  for (const url of [LEQUIPE, "https://example.org/"]) assert.equal(decide(ex, { url, now: MON }).verdict, "block");
  assert.ok(enforcement(ex, MON).redirect.includes("lequipe.fr"));
  const today = todaySummary(ex, MON);
  assert.deepEqual(today.sites.map((x) => [x.site, x.status]), [["example.org", "closed"], ["lequipe.fr", "closed"]]);
  assert.ok(today.sites.every((x) => x.exam));
  const gate = gateRequest(ex, { url: LEQUIPE, message: "I need it for the exam", now: MON }).payload;
  assert.deepEqual([gate.kind, gate.site, gate.budget], ["site", "lequipe.fr", 0], "a null limit is sent as budget 0, as the relay needs a number");
});

test("Today has one row per site under the kinds; the old state upgrades with no limits", () => {
  let s = setUp();
  s = proposeRules(s, { ...s.rules, siteLimits: { "lequipe.fr": 15 } }, MON).state;
  s = run(s, LEQUIPE, 4);
  const t = todaySummary(s, MON + 4 * 60e3);
  assert.deepEqual(t.kinds.map((k) => k.kind), ["social"]);
  assert.deepEqual(t.sites.map(({ kind, site, short, minutes, left, status }) => ({ kind, site, short, minutes, left, status })),
    [{ kind: "s:lequipe.fr", site: "lequipe.fr", short: "lequipe", minutes: 15, left: 11, status: "open" }]);
  const old = { ...initialState(), rules: { kinds: {}, sites: {}, videos: [], dayStart: 4 } };
  assert.deepEqual(upgrade(old).rules.siteLimits, {});
});

test("the chat's operations: siteLimit and dropSiteLimit, the earlier names read the same, malformed ones skipped", () => {
  const r = applyDiff({ kinds: {}, sites: {} }, [
    { op: "siteLimit", domain: "https://www.lequipe.fr/foot", minutes: 15 },
    { op: "siteBudget", domain: "example.org", minutes: 2000 },
    { op: "siteLimit", domain: "nytimes.com", minutes: null },
    { op: "siteLimit", domain: "lequipe", minutes: 5 },
    { op: "siteLimit", domain: "a.io", minutes: "lots" },
    { op: "dropSiteLimit", domain: "never.io" },
  ]);
  assert.deepEqual(r.rules.siteLimits, { "lequipe.fr": 15, "example.org": 1440, "nytimes.com": null });
  assert.equal(r.skipped.length, 3);
  assert.deepEqual(r.needsAccess, ["lequipe.fr", "example.org"], "a catalog site needs no new access");
  assert.deepEqual(applyDiff({ siteLimits: { "lequipe.fr": 15 } }, [{ op: "dropSite", domain: "lequipe.fr" }]).rules.siteLimits, {});
  assert.deepEqual(describeChanges({ kinds: {}, siteLimits: {} }, { kinds: {}, siteLimits: { "x.io": 0 } }).map((c) => c.text), ["x.io: closed all day"]);
});
