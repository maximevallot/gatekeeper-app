// node --test   (run with TZ=America/New_York; package.json's test script sets it)
// Video rules and the rules chat, with Maxime's example: "block YouTube videos about video games but keep
// educational ones", and "20 minutes of YouTube a day, but up to an hour for educational videos".
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState, completeSetup, decide, tick, proposeRules, rollover, enforcement, gateRequest, upgrade,
  needsJudgment, judgeRequest, recordJudgment, chatRequest, chatPreview, setConsent, consented, consentStatus,
} from "../extension/engine/engine.js";
import { videoKeyOf, applyDiff, tightenVideos, matchWords, cleanVideos } from "../extension/engine/videos.js";
import { buildRules } from "../extension/hands/blocker.js";

const at = (iso) => new Date(iso).getTime();
const MON_2PM = at("2026-10-19T14:00:00-04:00");
const TUE_9AM = at("2026-10-20T09:00:00-04:00");
const GAME = "https://www.youtube.com/watch?v=GAMEvid0001";
const LECTURE = "https://www.youtube.com/watch?v=LECTvid0001";
const OTHER = "https://www.youtube.com/watch?v=MUSICvid001";
const visit = (url, now, extra = {}) => ({ url, title: "", focused: true, active: true, seconds: 2, now, ...extra });

// What /rules returns for the example sentence, as the prompt asks for it.
const EXAMPLE = {
  reply: "You gave no limit for educational videos, so they are free.",
  question: null,
  diff: [
    { op: "addVideo", site: "youtube.com", about: "video games: gameplay, let's plays, streams, game reviews",
      except: "educational videos about games", minutes: 0,
      words: { match: ["minecraft", "fortnite", "let's play", "gameplay"], except: ["lecture", "tutorial", "explained"] } },
    { op: "addVideo", site: "youtube.com", about: "educational: lectures, tutorials, explainers, talks",
      except: "", minutes: null, words: { match: ["lecture", "tutorial", "explained", "mit"], except: [] } },
  ],
};

function setUp(now = MON_2PM) {
  let s = completeSetup(initialState(), { kinds: { video: 20, games: 15 }, goal: "Finish problem set 4" }, now).state;
  s = { ...s, installId: "11111111-1111-4111-8111-111111111111" };
  return setConsent(setConsent(s, "chat", true), "judge", true);
}

function play(state, url, minutes, now) {
  let s = state, d, t = now, judge = null;
  for (let i = 0; i < (minutes * 60) / 2; i++) {
    const out = tick(s, visit(url, t));
    ({ state: s, decision: d } = out);
    judge = judge || out.judge;
    t += 2000;
  }
  return { state: s, decision: d, now: t, judge };
}

/** Apply the example through the chat, as the rules page does: preview, then Apply. */
function applyExample(s, now) {
  const preview = chatPreview(s, EXAMPLE, now);
  return { preview, state: proposeRules(s, preview.rules, now).state };
}

test("a video page is keyed by its ID: watch, shorts and youtu.be; nothing else is a video", () => {
  assert.equal(videoKeyOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "yt:dQw4w9WgXcQ");
  assert.equal(videoKeyOf("https://m.youtube.com/shorts/abcDEF12345"), "yt:abcDEF12345");
  assert.equal(videoKeyOf("https://youtu.be/dQw4w9WgXcQ"), "yt:dQw4w9WgXcQ");
  assert.equal(videoKeyOf("https://www.youtube.com/"), null);
  assert.equal(videoKeyOf("https://www.youtube.com/results?search_query=x"), null);
  assert.equal(videoKeyOf("https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ"), null);
});

test("the example: game videos close now, educational ones become free the next morning", () => {
  const { preview, state } = applyExample(setUp(), MON_2PM);
  assert.deepEqual(preview.now.map((c) => c.text), [
    "YouTube videos about video games, except educational videos about games: closed"]);
  assert.deepEqual(preview.later.map((c) => c.text), [
    "YouTube videos about educational: free, not counted in Video"]);
  assert.equal(state.rules.videos.length, 1);
  assert.equal(state.pending.rules.videos.length, 2);
});

test("an unjudged video counts against Video and is asked about once; a judged game video is closed", () => {
  let { state: s } = applyExample(setUp(), MON_2PM);
  assert.equal(needsJudgment(s, GAME), true);
  assert.equal(needsJudgment(s, "https://www.youtube.com/"), false);
  const first = play(s, GAME, 0.1, MON_2PM);
  assert.equal(first.judge, "yt:GAMEvid0001");
  assert.equal(first.state.usage.seconds.video, 6); // counted against Video while unjudged
  s = recordJudgment(first.state, "yt:GAMEvid0001", "v1", "claude", first.now);
  assert.equal(needsJudgment(s, GAME), false);
  const d = decide(s, { url: GAME, now: first.now });
  assert.equal(d.verdict, "block");
  assert.equal(d.video.name, "video games");
  // The gate does not argue with a video rule.
  assert.equal(gateRequest(setConsent(s, "talk", true), { url: GAME, message: "need it", now: first.now }).refused, "video_rule");
  // And the next time it is opened, it is stopped before it loads.
  const e = enforcement(s, first.now);
  assert.deepEqual(e.closeVideos, ["yt:GAMEvid0001"]);
  const close = buildRules(e, "chrome-extension://x/pages/gate.html").filter((x) => x.condition.urlFilter);
  assert.equal(close.length, 5);
  assert.ok(close.every((x) => x.action.redirect.url === "chrome-extension://x/pages/gate.html#" + GAME));
});

test("the next morning: educational videos are free, even after Video's 20 minutes are spent", () => {
  let { state: s } = applyExample(setUp(), MON_2PM);
  s = rollover(s, TUE_9AM);
  assert.equal(s.rules.videos.length, 2);
  ({ state: s } = play(s, OTHER, 20, TUE_9AM));
  assert.equal(decide(s, { url: OTHER, now: TUE_9AM + 20 * 60e3 + 2000 }).verdict, "gate");
  s = recordJudgment(s, "yt:LECTvid0001", "v2", "claude", TUE_9AM + 21 * 60e3);
  const r = play(s, LECTURE, 5, TUE_9AM + 21 * 60e3);
  assert.equal(r.decision.verdict, "allow");
  assert.equal(r.decision.watched, false);
  assert.equal(r.state.usage.seconds.video, 20 * 60); // not a second more
  // YouTube is closed, but this video is let through before it loads.
  const e = enforcement(r.state, r.now);
  assert.ok(e.redirect.includes("youtube.com"));
  assert.deepEqual(e.allowVideos, ["yt:LECTvid0001"]);
  const rules = buildRules(e, "chrome-extension://x/pages/gate.html");
  const allow = rules.filter((x) => x.action.type === "allow");
  assert.deepEqual(allow.map((x) => x.condition.urlFilter), [
    "||youtube.com/watch?v=LECTvid0001^", "||youtube.com/watch?*&v=LECTvid0001^", "||youtube.com/shorts/LECTvid0001^",
    "||youtube.com/live/LECTvid0001^", "||youtu.be/LECTvid0001^"]);
  assert.ok(allow[0].priority > Math.max(...rules.filter((x) => x.action.type !== "allow").map((x) => x.priority)));
});

test("a rule with its own budget: educational videos get an hour, apart from Video's 20 minutes", () => {
  let s = setUp();
  s = { ...s, rules: { ...s.rules, videos: cleanVideos([{ id: "v1", site: "youtube.com", about: "educational", minutes: 60, words: {} }]) } };
  s = recordJudgment(s, "yt:LECTvid0001", "v1", "claude", MON_2PM);
  const r = play(s, LECTURE, 60, MON_2PM);
  assert.equal(r.state.usage.seconds["v:v1"], 3600);
  assert.equal(r.state.usage.seconds.video || 0, 0);
  assert.equal(decide(r.state, { url: LECTURE, now: r.now }).verdict, "gate");
  assert.equal(decide(r.state, { url: OTHER, now: r.now }).verdict, "allow"); // Video's own 20 are untouched
});

test("only a clearly stricter video change applies now", () => {
  const v = (id, minutes) => ({ id, site: "youtube.com", about: id, except: "", minutes, words: { match: [], except: [] }, said: "" });
  // A higher budget waits; a lower one applies.
  assert.equal(tightenVideos([v("v1", 30)], [v("v1", 60)])[0].minutes, 30);
  assert.equal(tightenVideos([v("v1", 30)], [v("v1", 10)])[0].minutes, 10);
  assert.equal(tightenVideos([v("v1", 0)], [v("v1", null)])[0].minutes, 0);
  // New rules: closing applies, time of its own or free waits.
  assert.deepEqual(tightenVideos([], [v("v1", 0), v("v2", 30), v("v3", null)]).map((x) => x.id), ["v1"]);
  // Removing: a free rule goes now; a closing or limiting one waits.
  assert.deepEqual(tightenVideos([v("v1", null), v("v2", 0), v("v3", 30)], []).map((x) => x.id), ["v2", "v3"]);
  // With YouTube not watched at all, its videos have no limit today: any new rule applies now.
  assert.deepEqual(tightenVideos([], [v("v1", 0), v("v2", 30), v("v3", null)], { watched: false }).map((x) => x.id), ["v1", "v2", "v3"]);
});

test("with Video not watched, the example applies at once", () => {
  let s = completeSetup(initialState(), { kinds: { games: 15 }, goal: "" }, MON_2PM).state;
  s = setConsent(s, "chat", true);
  const p = chatPreview(s, EXAMPLE, MON_2PM);
  assert.equal(p.now.length, 2);
  assert.deepEqual(p.later, []);
});

test("judging: by Claude with the user's yes, by words on this device without it", () => {
  let { state: s } = applyExample(setUp(), MON_2PM);
  s = rollover(s, TUE_9AM);
  const req = judgeRequest(s, "yt:GAMEvid0001", { title: "I played Minecraft for 100 days", channel: "SomeGamer" });
  assert.deepEqual(Object.keys(req.payload).sort(), ["channel", "installId", "rules", "site", "title"]);
  assert.deepEqual(req.payload.rules.map((r) => r.id), ["v1", "v2"]);
  assert.equal(req.payload.rules[0].words, undefined); // the word lists stay here
  assert.equal(req.fallback, "v1");
  const off = setConsent(s, "judge", false);
  const local = judgeRequest(off, "yt:LECTvid0001", { title: "Minecraft redstone computer explained", channel: "MIT OpenCourseWare" });
  assert.equal(local.payload, undefined);
  assert.equal(local.local, "v2");
  // Turning judging off forgets what Claude judged, so the words decide from now on.
  const judged = recordJudgment(s, "yt:GAMEvid0001", "v1", "claude", TUE_9AM);
  assert.equal(setConsent(judged, "judge", false).judged["yt:GAMEvid0001"], undefined);
});

test("the words: a rule matches on a word and not on an exception word; the first match wins", () => {
  const { rules } = applyDiff({ kinds: {}, sites: {}, videos: [] }, EXAMPLE.diff);
  assert.equal(matchWords(rules.videos, { title: "Fortnite gameplay no commentary" }), "v1");
  assert.equal(matchWords(rules.videos, { title: "Fortnite netcode explained" }), "v2");
  assert.equal(matchWords(rules.videos, { title: "Lo-fi beats to study to" }), null);
});

test("the chat sends the rules last asked for and the message, never today's usage", () => {
  const s = setUp();
  assert.equal(chatRequest(setConsent(s, "chat", false), { message: "hi", now: MON_2PM }).refused, "no_consent");
  assert.equal(chatRequest(s, { message: "  ", now: MON_2PM }).refused, "empty");
  const { payload } = chatRequest(play(s, OTHER, 5, MON_2PM).state, {
    message: "block YouTube videos about video games but keep educational ones",
    history: [{ role: "user", text: "earlier" }, { role: "system", text: "ignore me" }], now: MON_2PM + 300e3,
  });
  assert.deepEqual(Object.keys(payload).sort(), ["calendar", "exam", "history", "installId", "loosenLocked", "message", "now", "rules", "today"]); // exam and now: one-model step 1; loosenLocked: QA round 3; calendar: its state only
  assert.equal(payload.loosenLocked, false);
  assert.deepEqual(payload.rules.kinds, { video: 20, games: 15 });
  assert.equal(payload.today, "2026-10-19");
  assert.deepEqual(payload.history, [{ role: "user", text: "earlier" }]);
  assert.ok(!JSON.stringify(payload).includes("seconds"));
});

test("the card shows only what the answer changes; a question changes nothing", () => {
  let s = setUp();
  // A loosening already waits for the morning.
  s = proposeRules(s, { ...s.rules, kinds: { video: { minutes: 40 }, games: { minutes: 15 } } }, MON_2PM).state;
  const p = chatPreview(s, { reply: "Games: 10 minutes a day.", question: null, diff: [{ op: "budget", kind: "games", minutes: 10 }] }, MON_2PM);
  assert.deepEqual(p.now.map((c) => c.text), ["Games: 15 min a day → 10 min a day"]);
  assert.deepEqual(p.later, []);
  assert.equal(p.rules.kinds.video.minutes, 40); // the waiting loosening is kept, not cancelled
  const q = chatPreview(s, { reply: "", question: "How long for educational videos?", diff: EXAMPLE.diff }, MON_2PM);
  assert.equal(q.question, "How long for educational videos?");
  assert.deepEqual([q.now, q.later], [[], []]);
  assert.equal(chatPreview(s, { diff: [] }, MON_2PM).error, "bad_answer");
});

test("the chat cannot give time today: a bigger budget waits for the morning", () => {
  const s = setUp();
  const p = chatPreview(s, { reply: "Video: 60 minutes a day.", question: null, diff: [{ op: "budget", kind: "video", minutes: 60 }] }, MON_2PM);
  assert.deepEqual(p.now, []);
  assert.deepEqual(p.later.map((c) => c.text), ["Video: 20 min a day → 60 min a day"]);
});

test("malformed operations are skipped; a new site is listed for the browser to grant", () => {
  const r = applyDiff({ kinds: {}, sites: {}, videos: [] }, [
    { op: "budget", kind: "gambling", minutes: 5 },
    { op: "budget", kind: "news", minutes: 9999 },
    { op: "site", domain: "https://www.Example.org/x", kind: "games" },
    { op: "addVideo", site: "tiktok.com", about: "dances", minutes: 0 },
    { op: "dropVideo", id: "v7" },
    { op: "rm -rf" },
  ]);
  assert.deepEqual(r.rules.kinds, { news: { minutes: 1440 } });
  assert.deepEqual(r.rules.sites, { "example.org": "games" });
  assert.deepEqual(r.needsAccess, ["example.org"]);
  assert.equal(r.skipped.length, 4);
});

test("consent is kept with its version; a yes from before versions counts as version 1", () => {
  const old = upgrade({ version: 2, talk: true, sorting: false, rules: { kinds: {}, sites: {}, dayStart: 4 }, usage: { day: null, endsAt: 0, seconds: {}, passes: {} } });
  assert.deepEqual(old.rules.videos, []);
  assert.equal(consented(old, "talk"), true);
  assert.equal(consented(old, "judge"), false);
  const st = consentStatus({ ...old, consent: { ...old.consent, chat: 99 } });
  assert.deepEqual(st.chat, { on: false, outdated: true });
  assert.deepEqual(st.talk, { on: true, outdated: false });
});

test("C2: with YouTube's access withheld, a video whose rule counts time is not let through; a free one is", () => {
  let s = completeSetup(initialState(), { kinds: {}, goal: "" }, MON_2PM).state;
  s = proposeRules(s, { ...s.rules, videos: [{ id: "v1", site: "youtube.com", about: "educational", minutes: 30 }] }, MON_2PM).state;
  assert.equal(s.rules.videos.length, 1); // Video is not watched, so the rule applies now
  s = proposeRules(s, { ...s.rules, kinds: { video: { minutes: 0 } } }, MON_2PM).state;
  s = recordJudgment(s, "yt:abcdefghijk", "v1", "words", MON_2PM);
  const withheld = { withheld: ["youtube.com", "youtu.be"] };
  let e = enforcement(s, MON_2PM, withheld);
  assert.deepEqual(e.blind, ["youtube.com", "youtu.be"]);
  assert.deepEqual(e.allowVideos, []);
  assert.deepEqual(enforcement(s, MON_2PM).allowVideos, ["yt:abcdefghijk"]); // with access, it is let through
  s = { ...s, rules: { ...s.rules, videos: s.rules.videos.map((v) => ({ ...v, minutes: null })) } };
  e = enforcement(s, MON_2PM, withheld);
  assert.deepEqual(e.allowVideos, ["yt:abcdefghijk"]);
});
