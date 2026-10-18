// Your rules, saved as you go. Every change goes through the engine's proposeRules: what tightens applies
// now, what loosens waits for the morning and shows as an amber row with a way to keep today's number.
import { KINDS, KIND_ORDER, catalogKind } from "../engine/catalog.js";
import { DEFAULT_MINUTES, label, examOn } from "../engine/engine.js";
import { videoName } from "../engine/videos.js";
import {
  ask, el, when, clock, stepper, checkWorker, warnings, whatsSentToggle, chatIcon, privateToggle, extensionsPage,
  getAppearance, setAppearance, examForm,
} from "./common.js";

const $ = (id) => document.getElementById(id);
let got = null; // the background's last state reply
let warned = false;

const wanted = () => structuredClone(got.state.pending ? got.state.pending.rules : got.state.rules);

function saved(text, undo = null) {
  $("saved").replaceChildren(text);
  clearTimeout(saved.t);
  if (undo) {
    // A stray tap is undone for free for a minute (QA round 2, first-run H3).
    const b = el("button", { class: "link", type: "button", id: "undo" }, "Undo");
    b.addEventListener("click", () => propose(undo, {}, false));
    $("saved").append(" · ", b);
  }
  saved.t = setTimeout(() => { $("saved").textContent = "Saved as you go"; }, undo ? 60e3 : 4000);
}

async function propose(rules, extra = {}, undoable = true) {
  const before = got && wanted(); // what was asked for before this change, waiting changes included
  try {
    const r = await ask("propose", { rules, ...extra });
    const tightened = r.now && r.now.length;
    saved(r.refused === "asked_today" ? "Gatekeeper said no to a loosening today. Ask again tomorrow."
      : r.refused === "help_off_today" ? "Claude help was turned off today, so nothing loosens until tomorrow."
      : r.needsOk ? "Saved. To loosen it, tell Gatekeeper why."
      : r.later && r.later.length ? `Saved. Loosening applies ${when(r.from)}.` : tightened ? "Saved" : "Saved",
    undoable && tightened ? before : null);
  } catch {
    saved("Not saved: Gatekeeper's background didn't answer");
  }
  await load();
}

// ---------- daily time ----------

function subtitle(kind, rules, state) {
  const own = Object.entries(rules.sites || {}).filter(([, k]) => k === kind).map(([d]) => `${d} (you added)`);
  const sorted = Object.entries(state.sorted || {}).filter(([d, k]) => k === kind && !(d in (rules.sites || {}))).map(([d]) => `${d} (sorted by Claude)`);
  const known = KINDS[kind].examples.split(", ");
  const total = KINDS[kind].domains.length + own.length + sorted.length;
  const shown = [...known.slice(0, 3), ...own.slice(0, 2), ...sorted.slice(0, 1)];
  const more = total - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

function videoChips(rules) {
  const list = rules.videos || [];
  if (!list.length) return null;
  return el("div", { class: "chips", id: "video-rules" }, ...list.map((v) => {
    const cls = v.minutes === 0 ? "pill closed" : v.minutes === null ? "pill ok" : "pill";
    const what = v.minutes === 0 ? "closed" : v.minutes === null ? "free" : `${v.minutes} min`;
    const remove = el("button", { type: "button", "aria-label": `Remove the rule on ${videoName(v)} videos` }, "×");
    remove.addEventListener("click", () => {
      const r = wanted();
      r.videos = r.videos.filter((x) => x.id !== v.id);
      propose(r);
    });
    return el("span", { class: cls, "data-video": v.id }, `${videoName(v)}${v.except ? ` (not ${v.except})` : ""}: ${what}`, remove);
  }));
}

function pendingRow(kind, inForce, want) {
  const now = got.state.pending && got.state.pending.from;
  if (inForce && !want) {
    return el("div", { class: "note", "data-pending": kind }, el("span", {}, `Stops being watched ${when(now)}`),
      el("button", { class: "link", type: "button", onclick: () => keep(kind, inForce) }, "Keep watching"));
  }
  const asking = got.state.pending && got.state.pending.ok === false;
  if (inForce && want && want.minutes !== inForce.minutes) {
    return el("div", { class: "note", "data-pending": kind }, el("span", {}, asking ? `Going to ${want.minutes} min once Gatekeeper agrees, from the next morning` : `Going to ${want.minutes} min ${when(now)}`),
      el("button", { class: "link", type: "button", onclick: () => keep(kind, inForce) }, `Keep ${inForce.minutes === 0 ? "closed" : inForce.minutes}`));
  }
  return null;
}

function keep(kind, inForce) {
  const r = wanted();
  r.kinds[kind] = { minutes: inForce.minutes };
  propose(r);
}

let timers = {};
function kindRow(kind, rules, state) {
  const want = rules.kinds[kind], inForce = state.rules.kinds[kind];
  const value = (want || inForce).minutes;
  const step = stepper({
    value, label: KINDS[kind].label,
    onChange: (m) => {
      // Several clicks in a row are one change.
      clearTimeout(timers[kind]);
      timers[kind] = setTimeout(() => { const r = wanted(); r.kinds[kind] = { minutes: m }; propose(r); }, 450);
    },
  });
  const head = el("div", { class: "row", style: "padding: 0" },
    el("div", { class: "stack" }, el("div", { class: "name" }, KINDS[kind].label), el("div", { class: "sub" }, subtitle(kind, rules, state))),
    step);
  const parts = [head];
  if (kind === "video") { const chips = videoChips(rules); if (chips) parts.push(chips); }
  const p = pendingRow(kind, inForce, want);
  if (p) parts.push(p);
  return el("div", { class: "rowblock", "data-kind": kind }, ...parts);
}

// ---------- a site's own limit ----------
// One row per site with its own daily minutes, under the kinds. Its time counts against nothing else.

function setLimit(d, minutes) {
  const r = wanted();
  r.siteLimits = { ...(r.siteLimits || {}) };
  if (minutes === undefined) delete r.siteLimits[d]; else r.siteLimits[d] = minutes;
  propose(r);
}

function siteRow(d, rules, state) {
  const has = (x) => !!x.siteLimits && d in x.siteLimits;
  const want = has(rules) ? rules.siteLimits[d] : undefined;
  const inForce = has(state.rules) ? state.rules.siteLimits[d] : undefined;
  const value = want !== undefined ? want : inForce;
  const examOnly = value === null;
  const step = examOnly ? el("div", { class: "pill" }, "Exam mode only") : stepper({
    value, label: d,
    onChange: (m) => { clearTimeout(timers["s:" + d]); timers["s:" + d] = setTimeout(() => setLimit(d, m), 450); },
  });
  const toggle = el("button", { class: "link", type: "button", "data-exam-only": d }, examOnly ? "Give it daily minutes" : "Only in exam mode");
  toggle.addEventListener("click", () => setLimit(d, examOnly ? DEFAULT_MINUTES : null));
  const remove = el("button", { class: "link", type: "button", "data-remove-site": d }, "Remove");
  remove.addEventListener("click", () => setLimit(d, undefined));
  const head = el("div", { class: "row", style: "padding: 0" },
    el("div", { class: "stack" }, el("div", { class: "name" }, d),
      el("div", { class: "sub" }, examOnly ? "Open every day; closed in exam mode" : "Its own limit, apart from any kind"),
      el("div", { class: "sub" }, toggle, " · ", remove)),
    step);
  const parts = [head];
  const now = got.state.pending && got.state.pending.from;
  const asking = got.state.pending && got.state.pending.ok === false;
  const says = (m) => (m === undefined ? "No own limit" : m === null ? "Exam mode only" : m === 0 ? "Closed" : `${m} min`);
  if (inForce !== want && got.state.pending) {
    const keepIt = el("button", { class: "link", type: "button", onclick: () => setLimit(d, inForce) }, inForce === undefined ? "Don't add" : `Keep ${says(inForce).toLowerCase()}`);
    parts.push(el("div", { class: "note", "data-pending": "s:" + d },
      el("span", {}, `${says(want)} ${asking ? "once Gatekeeper agrees, from the next morning" : when(now)}`), keepIt));
  }
  return el("div", { class: "rowblock", "data-site-limit": d }, ...parts);
}

function renderKinds() {
  const { state } = got;
  const rules = wanted();
  const watched = KIND_ORDER.filter((k) => rules.kinds[k] || state.rules.kinds[k]);
  const unwatched = KIND_ORDER.filter((k) => !watched.includes(k));
  const rows = watched.map((k) => kindRow(k, rules, state));
  // Video rules apply even when Video itself is not watched: they still need a place to be seen.
  const chips = !watched.includes("video") && videoChips(rules);
  if (chips) {
    rows.push(el("div", { class: "rowblock", "data-kind": "videos-only" },
      el("div", { class: "stack" }, el("div", { class: "name" }, "YouTube videos"), el("div", { class: "sub" }, "Video isn't watched; these rules still apply.")),
      chips));
  }
  const limited = [...new Set([...Object.keys(rules.siteLimits || {}), ...Object.keys(state.rules.siteLimits || {})])].sort();
  rows.push(...limited.map((d) => siteRow(d, rules, state)));
  if (unwatched.length) {
    const links = unwatched.flatMap((k, i) => {
      const b = el("button", { class: "link", type: "button", "data-add": k }, KINDS[k].label);
      b.addEventListener("click", () => { const r = wanted(); r.kinds[k] = { minutes: DEFAULT_MINUTES }; propose(r); });
      return i ? [", ", b] : [b];
    });
    rows.push(el("div", { class: "row muted small" }, el("span", {}, "Not watched: ", ...links, ". Tap one to add it.")));
  }
  rows.push(addSiteRow());
  $("kinds").replaceChildren(...rows);
}

function addSiteRow() {
  const form = el("form", { class: "inline hidden", id: "site-form" },
    el("input", { class: "field", id: "new-site", placeholder: "example.com", autocomplete: "off", "aria-label": "A site to add" }),
    el("select", { class: "field", id: "new-kind", style: "flex: 0 0 140px", "aria-label": "Its limit" },
      el("option", { value: "" }, "Its own limit"),
      el("option", { value: "study" }, "A study site (open in exam mode)"),
      ...KIND_ORDER.map((k) => el("option", { value: k }, `Counts as ${KINDS[k].label.toLowerCase()}`))),
    el("button", { class: "btn", type: "submit" }, "Add"));
  const open = el("button", { class: "link", type: "button", style: "align-self: flex-start" }, "Limit one site");
  open.addEventListener("click", () => { form.classList.remove("hidden"); open.classList.add("hidden"); $("new-site").focus(); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let d = $("new-site").value.trim().toLowerCase();
    try { d = new URL(d.includes("://") ? d : "https://" + d).hostname.replace(/^www\./, ""); } catch { return; }
    if (!d.includes(".")) return;
    const kind = $("new-kind").value;
    // Gatekeeper may act only on the sites in its catalog; any other is asked for here, inside the click.
    const access = kind === "study" ? Promise.resolve(true) : kind || !catalogKind(d) ? chrome.permissions.request({ origins: [`*://*.${d}/*`] }) : Promise.resolve(true);
    access.then((granted) => {
      if (!granted) { saved(`Not added: Gatekeeper needs access to ${d}`); return; }
      if (!kind) { setLimit(d, DEFAULT_MINUTES); return; } // its own limit, counted against nothing else
      if (kind === "study") { const r = wanted(); r.study = [...new Set([...(r.study || []), d])]; propose(r); return; }
      const r = wanted();
      r.sites = { ...(r.sites || {}), [d]: kind };
      propose(r);
    });
  });
  return el("div", { class: "rowblock small" }, open, form);
}

// ---------- settings ----------

function renderSettings() {
  const { state, consent = {}, incognito } = got;
  $("goal-text").textContent = state.goal || "Not set";
  $("goal").value = state.goal || "";
  const help = consent.help || {};
  $("help").checked = !!help.on;
  const outdated = help.outdated || (!help.on && Object.values(consent).some((c) => c && c.on));
  $("help-sub").textContent = help.on
    ? (state.sorting ? "On: gate answers, rule changes by talking, sorting new sites." : "On: gate answers and rule changes by talking. Sorting new sites needs your browser to let Gatekeeper see every site.")
    : outdated ? "What's sent changed since you last agreed. Turn it on to agree to the list below." : "Off: nothing is sent.";
  $("private-pill").textContent = incognito ? "Covered" : "Not covered";
  $("private-pill").className = incognito ? "pill ok" : "pill warn";
  $("private-sub").textContent = incognito ? "Gatekeeper works in private windows too." : `Turn on "${privateToggle()}" for Gatekeeper in ${extensionsPage()}.`;
  for (const b of $("appearance").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.choice === getAppearance()));
}

const sent = whatsSentToggle();
$("help-sub").after(el("div", {}, sent.link));
$("help-sent").append(sent.list);

$("help").addEventListener("change", () => {
  const on = $("help").checked;
  // Access to every site is asked only where it is first needed, when exam mode starts (tester run, #4); turning
  // AI help on doesn't ask for it.
  Promise.resolve().then(async () => {
    try { await ask("consent", { help: on }); saved(on ? "Claude help is on" : "Claude help is off: nothing is sent"); }
    catch { saved("Not saved: Gatekeeper's background didn't answer"); }
    await load();
  });
});

$("goal-edit").addEventListener("click", () => { $("goal-form").classList.toggle("hidden"); $("goal").focus(); });
$("goal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("goal-form").classList.add("hidden");
  propose(wanted(), { goal: $("goal").value });
});

$("appearance").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-choice]");
  if (!b) return;
  setAppearance(b.dataset.choice);
  renderSettings();
});

$("talk-link").append(chatIcon(), "Change something by talking");

// ---------- exam mode ----------

function renderExam() {
  const s = got.state;
  const on = examOn(s);
  $("exam-row").classList.toggle("hidden", !on);
  $("exam-start-row").classList.toggle("hidden", on);
  if (!on) return;
  $("exam-title").textContent = `Exam mode until ${when(s.rules.exam.until)}`;
  // Everything but study is closed; sites Gatekeeper doesn't know can only be closed where it may see every site.
  $("exam-goal").textContent = (s.rules.exam.goal ? s.rules.exam.goal + ". " : "") + (got.seeAll
    ? "Everything but study sites is closed until then."
    : "Every kind of site is closed until then. Sites Gatekeeper doesn't know stay open: turn on Claude help and let it see all sites to close them.");
  // The Mac app's "End exam mode early" opens this page at #exam.
  if (location.hash === "#exam" && !renderExam.opened) { renderExam.opened = true; $("exam-end-open").focus(); }
}
window.addEventListener("hashchange", () => { renderExam.opened = false; if (got) renderExam(); });

$("exam-start").addEventListener("click", () => {
  $("exam-start-box").replaceChildren(examForm(async (r) => {
    saved(r.ok ? `Exam mode is on until ${when(r.exam.until)}` : r.refused === "bad_until" ? "Pick a time ahead" : "Not saved");
    $("exam-start-box").replaceChildren();
    await load();
  }, "rules"));
  $("exam-until").focus();
});

// Ending early asks the agent (decision of 2026-10-17): a yes ends it at once if the exam is over, else the
// next morning. With Claude help off it runs to its set end.
$("exam-end-open").addEventListener("click", async () => {
  const r = await ask("endExam").catch(() => ({ refused: "unreachable" }));
  const note = {
    ends_anyway: `It ends ${when(r.until)} anyway, before the next morning. Nothing to ask.`,
    help_off: `With Claude help off, exam mode runs to its end, ${when(r.until)}.`,
    asked_today: "Gatekeeper said no to that today. Ask again tomorrow.",
    not_on: "Exam mode is already off.",
    unreachable: "Not saved: Gatekeeper's background didn't answer.",
  }[r.refused];
  $("exam-note").textContent = note || "";
  $("exam-note").classList.toggle("hidden", !note);
  if (r.needsOk) saved("To end it early, tell Gatekeeper why");
  await load();
  if (r.needsOk) $("loosen-message").focus();
});

// ---------- the key to loosening ----------

function renderLoosen() {
  const l = got.state.loosen;
  $("loosen-card").classList.toggle("hidden", !l);
  if (!l) return;
  $("loosen-title").textContent = l.kind === "exam" ? "To end exam mode early, tell Gatekeeper why" : "To loosen this, tell Gatekeeper why";
  $("loosen-changes").replaceChildren(...l.changes.map((c) => el("li", {}, c)));
}
function loosenSay(text, me) {
  $("loosen-log").append(el("div", { class: "bubble" + (me ? " me" : "") }, text));
}
$("loosen-drop").addEventListener("click", async () => { await ask("dropLoosen").catch(() => null); saved("Dropped: nothing loosens"); await load(); });
$("loosen-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("loosen-message").value.trim();
  if (!text) return;
  loosenSay(text, true);
  $("loosen-message").value = "";
  $("loosen-send").disabled = true;
  const r = await ask("loosen", { message: text }).catch(() => ({ decision: "unavailable" }));
  $("loosen-send").disabled = false;
  if (r.decision === "allow") { loosenSay(r.reply); saved(r.now ? "Agreed: it applies now" : `Agreed: it applies ${when(r.from)}`); }
  else if (r.decision === "ask") { loosenSay(r.reply); $("loosen-message").focus(); return; }
  else if (r.decision === "deny") { loosenSay(r.reply); saved("The rule stays. You can ask again tomorrow."); }
  else if (r.decision === "unavailable") { saved("Couldn't reach Gatekeeper. Nothing loosens yet; ask again later."); await load(); return; }
  else saved("Nothing was sent");
  await load();
  $("loosen-card").classList.add("hidden");
});

// ---------- the calendar link ----------

function renderCalendar() {
  const c = got.state.calendar;
  $("calendar-sub").textContent = !c
    ? "Paste a calendar link once, and exam mode offers itself before an exam. It's read on this computer only."
    : c.error ? `Couldn't read the calendar (${c.error}).`
    : `Connected: ${c.events.length} event${c.events.length === 1 ? "" : "s"} in the next two weeks. Read on this computer once a day.`;
  $("calendar-edit").textContent = c ? "Disconnect" : "Connect";
}
$("calendar-edit").addEventListener("click", async () => {
  if (got.state.calendar) { await ask("setCalendar", { url: null }); await load(); return; }
  $("calendar-form").classList.toggle("hidden");
  $("calendar-url").focus();
});
$("calendar-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("calendar-url").value.trim().replace(/^webcals?:\/\//i, "https://");
  let origin;
  try { origin = new URL(raw).origin; } catch { saved("That isn't a calendar link"); return; }
  // Reading the link needs the browser's yes for that one site, asked inside the click.
  chrome.permissions.request({ origins: [origin + "/*"] }).then(async (granted) => {
    if (!granted) { saved("Not connected: Gatekeeper needs to read that site"); return; }
    const r = await ask("setCalendar", { url: raw }).catch(() => ({ refused: "unreachable" }));
    saved(r.refused ? "Not connected" : r.error ? `Connected, but couldn't read it yet (${r.error})` : `Connected: ${r.events} events`);
    $("calendar-form").classList.add("hidden");
    await load();
  });
});

// ---------- the Mac app ----------

const NATIVE = { permissions: ["nativeMessaging"] };
async function renderMac() {
  // If the background doesn't answer (an old worker beside these pages), say what the browser has granted,
  // and that a reload connects it, rather than showing the switch off.
  const m = await ask("mac").catch(async () => ({ permitted: await chrome.permissions.contains(NATIVE).catch(() => false), error: "reload_needed" }));
  m.error = m.macError || m.error;
  // Testers can't get Gatekeeper for Mac yet: its switch shows only once a Mac app has answered, or it is on.
  $("mac-row").classList.toggle("hidden", !m.seen && !m.permitted);
  $("mac").checked = !!m.permitted;
  $("mac-sub").textContent = !m.permitted
    ? "Off. With Gatekeeper for Mac on, your goal, each kind's minutes today and exam mode go to a file on this Mac that apps you run can read. Nothing goes to a server."
    : m.connected
      ? "Connected. Your goal, each kind's minutes today and exam mode go to Gatekeeper for Mac, in a file on this Mac that apps you run can read. Nothing goes to a server."
      : m.error === "reload_needed"
        ? "Reload Gatekeeper once (in your browser's extensions page) to connect."
        : m.error === "other_browser_linked"
          ? `Gatekeeper for Mac follows ${m.linkedName}. To follow this browser instead, change it in Gatekeeper for Mac's Settings.`
          : m.error === "mac_outdated"
            ? "Update Gatekeeper for Mac: this version can't read what the extension sends."
            : m.error === "bad_message"
              ? `Gatekeeper for Mac couldn't read today's update${m.reason ? ` (${m.reason})` : ""}. Updating both may fix it.`
              : "Gatekeeper for Mac isn't answering. Is it installed and open?";
}
$("mac").addEventListener("change", () => {
  // The browser asks the user; the request has to start inside the click.
  const change = $("mac").checked ? chrome.permissions.request(NATIVE) : chrome.permissions.remove(NATIVE);
  change.catch(() => false).then(renderMac);
});

async function load() {
  got = await ask("state");
  // During the watch week the rules wait: nothing is blocked until it ends or the user ends it.
  if (got.state.watch && !got.state.watch.ended && got.now < got.state.watch.until && !$("watch-note")) {
    const end = el("button", { class: "link", type: "button" }, "Set limits now");
    end.addEventListener("click", () => { location.href = "welcome.html?after=watch"; });
    $("daily").before(el("div", { class: "note", id: "watch-note" }, el("span", {}, `Watch week until ${when(got.state.watch.until)}: nothing is blocked yet.`), end));
  }
  if (!warned) warned = warnings({ ...got, incognito: true }, $("daily")) >= 0; // private windows: shown in Settings
  renderKinds();
  renderSettings();
  renderExam();
  renderMac();
  renderLoosen();
  renderCalendar();
}

checkWorker();
load();
