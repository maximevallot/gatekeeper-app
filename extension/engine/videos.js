// Video rules: rules finer than a site. On YouTube, a rule in the user's words about a kind of video
// ("video games, except educational ones") with its own daily budget: 0 closes those videos, a number of
// minutes gives them their own time, null makes them free. A video a rule matches counts against that rule,
// never against the Video kind; a video no rule matches counts against Video as before.
//
// Which rule a video falls under is judged once per video, from its title and channel: by Claude through
// the relay when the user said yes to that, otherwise by the rule's word lists on this device. The engine
// keeps the answer per video ID. Nothing here touches a browser or the network.
//
// The rules chat also lives here: it turns the relay's list of operations into the rules the user would
// have, which then go through proposeRules like any other change.

import { KINDS, hostOf, matches, catalogKind, ruleDomain } from "./catalog.js";

export const VIDEO_SITES = ["youtube.com"]; // the only site with video rules for now
export const MAX_VIDEO_RULES = 20;
export const MAX_JUDGED = 300; // judgments kept on the device, the most recent first
export const MAX_WORDS = 20;

const text = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

/** "yt:<id>" for a YouTube video page (watch, shorts, youtu.be), or null for any other page. */
export function videoKeyOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = hostOf(url);
  if (!host) return null;
  let id = null;
  if (matches(host, "youtu.be")) id = u.pathname.split("/")[1];
  else if (matches(host, "youtube.com")) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (/^\/(shorts|live)\//.test(u.pathname)) id = u.pathname.split("/")[2];
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? "yt:" + id : null;
}

/** The address of a video from its key, for asking YouTube its title and channel. */
export function videoUrl(key) {
  return "https://www.youtube.com/watch?v=" + key.slice(3);
}

/** The site a video page is on, as video rules name it. */
export function videoSiteOf(url) {
  const host = hostOf(url);
  return host ? VIDEO_SITES.find((s) => matches(host, s) || (s === "youtube.com" && matches(host, "youtu.be"))) || null : null;
}

function cleanWords(list) {
  return Array.isArray(list)
    ? [...new Set(list.map((w) => text(w, 40).toLowerCase()).filter(Boolean))].slice(0, MAX_WORDS)
    : [];
}

/** null (free), or whole minutes from 0 to 1440. */
export function cleanVideoMinutes(m) {
  if (m === null || m === undefined || m === "free") return null;
  const n = Math.round(Number(m));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1440) : null;
}

/** Video rules as the user may set them. Anything malformed is dropped, never guessed. */
export function cleanVideos(list) {
  const out = [];
  const ids = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    if (!v || typeof v !== "object") continue;
    const id = String(v.id || "");
    const about = text(v.about, 200);
    if (!/^v[0-9]{1,6}$/.test(id) || ids.has(id) || !about || !VIDEO_SITES.includes(v.site)) continue;
    ids.add(id);
    out.push({
      id, site: v.site, about, except: text(v.except, 200), minutes: cleanVideoMinutes(v.minutes),
      words: { match: cleanWords(v.words && v.words.match), except: cleanWords(v.words && v.words.except) },
      said: text(v.said, 300),
    });
    if (out.length >= MAX_VIDEO_RULES) break;
  }
  return out;
}

/** What a judgment depends on. A judgment made under other wording is asked again. */
export function videoRulesKey(videos, site) {
  return JSON.stringify((videos || []).filter((v) => v.site === site).map((v) => [v.id, v.about, v.except]));
}

/** Short name of a rule for the pages: "video games" from "video games: gameplay, let's plays". */
export function videoName(v) {
  return v.about.split(":")[0].trim();
}

/**
 * The rule a video falls under by its word lists alone, or null. A rule matches when one of its words is
 * in the title or channel and none of its exception words is. The first matching rule wins.
 */
export function matchWords(videos, { title = "", channel = "" }) {
  const hay = (" " + title + " " + channel + " ").toLowerCase();
  const has = (w) => hay.includes(w);
  for (const v of videos) {
    if (v.words.match.some(has) && !v.words.except.some(has)) return v.id;
  }
  return null;
}

// ---------- tightening ----------

// How much a rule lets through: closed, its own minutes, or free.
const looseness = (m) => (m === 0 ? 0 : m === null ? Infinity : m);

/**
 * The stricter of the video rules in force (cur) and those asked for (next), rule by rule, by id.
 * A change applies now only when it is clearly stricter: a new rule that closes, a lower budget, or removing
 * a rule that made videos free. Everything else waits for the morning: a new rule with time of its own or
 * free, a higher budget, removing a rule that closed or limited. When the site's own kind is not watched
 * (`watched` false), its videos have no limit today, so any new rule is at least as strict and applies now.
 * A rule's wording never changes in place; the chat rewords by removing one rule and adding another.
 */
export function tightenVideos(cur = [], next = [], { watched = true } = {}) {
  const byId = (l) => new Map(l.map((v) => [v.id, v]));
  const a = byId(cur), b = byId(next);
  const out = [];
  for (const v of next) {
    const old = a.get(v.id);
    if (!old) { if (v.minutes === 0 || !watched) out.push(v); continue; }
    out.push({ ...old, minutes: looseness(v.minutes) <= looseness(old.minutes) ? v.minutes : old.minutes });
  }
  for (const old of cur) {
    if (!b.has(old.id) && old.minutes !== null) out.push(old); // dropping a free rule applies now
  }
  return out;
}

export function videoMinutesText(m) {
  return m === 0 ? "closed" : m === null ? "free, not counted in Video" : `${m} min a day of their own`;
}

/** Each difference between two lists of video rules, in words a person reads. */
export function describeVideoChanges(cur = [], next = []) {
  const out = [];
  const a = new Map(cur.map((v) => [v.id, v]));
  const b = new Map(next.map((v) => [v.id, v]));
  const what = (v) => `YouTube videos about ${videoName(v)}${v.except ? `, except ${v.except}` : ""}`;
  for (const v of next) {
    const old = a.get(v.id);
    if (!old) out.push({ video: v.id, text: `${what(v)}: ${videoMinutesText(v.minutes)}` });
    else if (old.minutes !== v.minutes) out.push({ video: v.id, text: `${what(v)}: ${videoMinutesText(old.minutes)} → ${videoMinutesText(v.minutes)}` });
  }
  for (const old of cur) if (!b.has(old.id)) out.push({ video: old.id, text: `${what(old)}: rule removed` });
  return out;
}

// ---------- the rules chat ----------

const OPS = ["budget", "unwatch", "site", "unsite", "siteLimit", "dropSiteLimit", "addVideo", "videoBudget", "dropVideo", "dayStart", "examStart", "examEnd"];
// Earlier names for a site's own limit, from before the relay's were settled: read as the same.
const ALIASES = { siteBudget: "siteLimit", dropSite: "dropSiteLimit" };

function domainOf(raw) {
  return ruleDomain(raw); // a host with a dot, not a public suffix ("co.uk", "github.io")
}

/**
 * The rules the user would have after the relay's operations, applied to `rules` (what the user last asked
 * for, pending included). Unknown or malformed operations are skipped and listed in `skipped`. Adding a site
 * outside the catalog lists it in `needsAccess`, since the browser must grant it before it can be closed.
 */
export function applyDiff(rules, diff) {
  const r = structuredClone({ kinds: {}, sites: {}, siteLimits: {}, videos: [], ...rules });
  r.videos = r.videos || [];
  r.siteLimits = r.siteLimits || {};
  const skipped = [], needsAccess = [];
  let examEnd = false;
  let n = r.videos.reduce((m, v) => Math.max(m, Number(v.id.slice(1)) || 0), 0);
  for (const op of Array.isArray(diff) ? diff.slice(0, 10) : []) {
    const kind = op && KINDS[op.kind] ? op.kind : null;
    const name = op && (ALIASES[op.op] || op.op);
    switch (OPS.includes(name) ? name : null) {
      case "budget":
        if (!kind || !Number.isFinite(Number(op.minutes))) { skipped.push(op); break; }
        r.kinds[kind] = { minutes: Math.min(Math.max(Math.round(Number(op.minutes)), 0), 1440) };
        break;
      case "unwatch":
        if (!kind) { skipped.push(op); break; }
        delete r.kinds[kind];
        break;
      case "site": {
        const d = domainOf(op.domain);
        if (!d || !kind) { skipped.push(op); break; }
        r.sites[d] = kind;
        needsAccess.push(d);
        break;
      }
      case "unsite": {
        const d = domainOf(op.domain);
        if (!d || !(d in r.sites)) { skipped.push(op); break; }
        delete r.sites[d];
        break;
      }
      case "siteLimit": {
        // A site's own daily minutes, counted against nothing else; null: closed only in exam mode.
        const d = domainOf(op.domain);
        const m = op.minutes === null ? null : Number(op.minutes);
        if (!d || (m !== null && !Number.isFinite(m))) { skipped.push(op); break; }
        r.siteLimits[d] = m === null ? null : Math.min(Math.max(Math.round(m), 0), 1440);
        if (!catalogKind(d)) needsAccess.push(d);
        break;
      }
      case "dropSiteLimit": {
        const d = domainOf(op.domain);
        if (!d || !(d in r.siteLimits)) { skipped.push(op); break; }
        delete r.siteLimits[d];
        break;
      }
      case "addVideo": {
        if (!VIDEO_SITES.includes(op.site) || !text(op.about, 200) || r.videos.length >= MAX_VIDEO_RULES) { skipped.push(op); break; }
        r.videos.push({ id: "v" + ++n, site: op.site, about: op.about, except: op.except || "", minutes: cleanVideoMinutes(op.minutes), words: op.words || {}, said: op.said || "" });
        break;
      }
      case "videoBudget": {
        const v = r.videos.find((x) => x.id === op.id);
        if (!v) { skipped.push(op); break; }
        v.minutes = cleanVideoMinutes(op.minutes);
        break;
      }
      case "dropVideo": {
        const i = r.videos.findIndex((x) => x.id === op.id);
        if (i < 0) { skipped.push(op); break; }
        r.videos.splice(i, 1);
        break;
      }
      case "examStart": {
        // Start exam mode, or move its end later; whether that is now or too far ahead is the engine's call.
        // The relay sends local time with its offset ("2026-10-22T08:30:00-04:00"); a number is taken as ms.
        const until = typeof op.until === "number" ? op.until : Date.parse(String(op.until || ""));
        if (!Number.isFinite(until)) { skipped.push(op); break; }
        r.exam = { until, goal: text(op.goal, 200) || (r.exam && r.exam.goal) || "" };
        break;
      }
      case "examEnd":
        // Ending early is a loosening: it becomes a request to the agent on Apply, never an end by itself.
        examEnd = true;
        break;
      case "dayStart": {
        const h = Number(op.hour);
        if (!Number.isInteger(h) || h < 0 || h > 23) { skipped.push(op); break; }
        r.dayStart = h;
        break;
      }
      default:
        skipped.push(op);
    }
  }
  r.videos = cleanVideos(r.videos);
  return { rules: r, skipped, needsAccess: [...new Set(needsAccess)], examEnd };
}

/** The rules as the relay's /rules reads them: no word lists, nothing about today's usage. */
export function rulesForChat(rules) {
  return {
    kinds: Object.fromEntries(Object.entries(rules.kinds || {}).map(([k, v]) => [k, v.minutes])),
    sites: { ...(rules.sites || {}) },
    siteLimits: { ...(rules.siteLimits || {}) },
    videos: (rules.videos || []).map(({ id, site, about, except, minutes }) => ({ id, site, about, except, minutes })),
    dayStart: rules.dayStart,
  };
}
