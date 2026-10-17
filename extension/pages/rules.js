// Your rules, saved as you go. Every change goes through the engine's proposeRules: what tightens applies
// now, what loosens waits for the morning and shows as an amber row with a way to keep today's number.
import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, label, examOn, EXAM_END_SENTENCE } from "../engine/engine.js";
import { videoName } from "../engine/videos.js";
import {
  ask, el, when, clock, stepper, checkWorker, warnings, whatsSentToggle, chatIcon, privateToggle, extensionsPage,
  getAppearance, setAppearance,
} from "./common.js";

const $ = (id) => document.getElementById(id);
let got = null; // the background's last state reply
let warned = false;

const wanted = () => structuredClone(got.state.pending ? got.state.pending.rules : got.state.rules);

function saved(text) {
  $("saved").textContent = text;
  clearTimeout(saved.t);
  saved.t = setTimeout(() => { $("saved").textContent = "Saved as you go"; }, 4000);
}

async function propose(rules, extra = {}) {
  try {
    const r = await ask("propose", { rules, ...extra });
    saved(r.later && r.later.length ? `Saved. Loosening applies ${when(r.from)}.` : "Saved");
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
  if (inForce && want && want.minutes !== inForce.minutes) {
    return el("div", { class: "note", "data-pending": kind }, el("span", {}, `Going to ${want.minutes} min ${when(now)}`),
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
    el("select", { class: "field", id: "new-kind", style: "flex: 0 0 140px", "aria-label": "Its kind" },
      ...KIND_ORDER.map((k) => el("option", { value: k }, KINDS[k].label))),
    el("button", { class: "btn", type: "submit" }, "Add"));
  const open = el("button", { class: "link", type: "button", style: "align-self: flex-start" }, "Add a site Gatekeeper doesn't know");
  open.addEventListener("click", () => { form.classList.remove("hidden"); open.classList.add("hidden"); $("new-site").focus(); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let d = $("new-site").value.trim().toLowerCase();
    try { d = new URL(d.includes("://") ? d : "https://" + d).hostname.replace(/^www\./, ""); } catch { return; }
    if (!d.includes(".")) return;
    const kind = $("new-kind").value;
    // Gatekeeper may act only on the sites in its catalog; any other is asked for here, inside the click.
    chrome.permissions.request({ origins: [`*://*.${d}/*`] }).then((granted) => {
      if (!granted) { saved(`Not added: Gatekeeper needs access to ${d}`); return; }
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
  // Sorting new sites needs to see every site; the browser asks, and the request has to start in the click.
  const permission = on ? chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false) : chrome.permissions.remove({ origins: ["*://*/*"] }).catch(() => false);
  permission.then(async () => {
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
  if (!on) return;
  $("exam-title").textContent = `Exam mode until ${when(s.rules.exam.until)}`;
  $("exam-goal").textContent = s.rules.exam.goal || "Every kind of site is closed until then.";
  $("exam-hint").textContent = `To end it now, type: ${EXAM_END_SENTENCE}`;
}
$("exam-end-open").addEventListener("click", () => { $("exam-form").classList.toggle("hidden"); $("exam-sentence").focus(); });
$("exam-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await ask("endExam", { sentence: $("exam-sentence").value }).catch(() => ({ refused: "unreachable" }));
  saved(r.ok ? "Exam mode is off" : r.refused === "wrong_sentence" ? "That isn't the sentence; exam mode stays on" : "Not saved");
  $("exam-sentence").value = "";
  load();
});

// ---------- the Mac app ----------

const NATIVE = { permissions: ["nativeMessaging"] };
async function renderMac() {
  const m = await ask("mac").catch(() => ({ permitted: false }));
  $("mac").checked = !!m.permitted;
  $("mac-sub").textContent = !m.permitted
    ? "Off. With Gatekeeper for Mac, shares today's minutes and exam mode, on this Mac only."
    : m.connected
      ? "Connected. Shares your goal, each kind's minutes today and exam mode with Gatekeeper for Mac. It stays on this Mac."
      : m.error === "reload_needed"
        ? "Reload Gatekeeper once (in your browser's extensions page) to connect."
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
}

checkWorker();
load();
