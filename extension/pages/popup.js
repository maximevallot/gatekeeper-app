// Today, in the toolbar popup: a ring per watched kind (minutes left, or a lock when closed), the goal, and
// the way to change something.
import { todaySummary } from "../engine/engine.js";
import { ask, el, svg, lockIcon, chatIcon, clock, checkWorker, examForm, extensionsPage, askEverySite, siteAccessHelp, openAccessButton, EVERY_SITE_LINE } from "./common.js";

const $ = (id) => document.getElementById(id);
const C = 2 * Math.PI * 40;

function openTab(page) {
  chrome.tabs.create({ url: chrome.runtime.getURL("pages/" + page) });
  window.close();
}

function ring(k, reopensAt) {
  const closed = k.status !== "open";
  const dial = el("div", { class: "dial" },
    svg("svg", { width: 96, height: 96, viewBox: "0 0 96 96", role: "img",
      "aria-label": closed ? `${k.label}: closed` : `${k.label}: ${k.left} of ${k.minutes} minutes left` },
      svg("circle", { cx: 48, cy: 48, r: 40, fill: "none", class: "track" + (closed ? " closed" : ""), "stroke-width": 10 }),
      ...(closed ? [] : [svg("circle", { cx: 48, cy: 48, r: 40, fill: "none", class: "fill", "stroke-width": 10, "stroke-linecap": "round",
        "stroke-dasharray": `${Math.max(0.5, k.fraction * C)} ${C}`, transform: "rotate(-90 48 48)" })])),
    closed ? lockIcon(28) : el("div", { class: "count" }, String(k.left)));
  const state = k.status === "open" ? el("div", { class: "state" }, "min left")
    : el("div", { class: "state closed" }, k.exam ? "exam" : k.status === "closed" ? "all day" : `till ${clock(reopensAt)}`);
  return el("div", { class: "ring", "data-kind": k.kind }, dial, el("div", { class: "label" }, k.short), state);
}

async function show() {
  const { state, now, blind, seeAll } = await ask("state");
  const t = todaySummary(state, now);
  if (!t.setupDone) {
    $("rings").replaceChildren(el("p", { class: "lead", style: "grid-column: 1 / -1" }, "Gatekeeper isn't set up yet. It takes a minute."));
    $("change").replaceChildren("Set it up");
    $("change").onclick = (e) => { e.preventDefault(); openTab("welcome.html"); };
    return;
  }
  if (t.watch) return showWatch(t);
  if (t.watchReady) {
    $("mode").textContent = "Your week is ready"; $("mode").className = "pill ok";
    $("mode").onclick = () => openTab("week.html?ready=1");
  }
  // A ring per watched kind, then one per site with its own limit (one closed only in exam mode shows in exam mode).
  const rings = [...t.kinds, ...(t.sites || []).filter((k) => k.minutes !== null || k.exam)];
  $("rings").replaceChildren(...(rings.length ? rings.map((k) => ring(k, t.reopensAt))
    : [el("p", { class: "lead", style: "grid-column: 1 / -1" }, "Nothing is watched yet.")]));
  $("goal").textContent = t.goal;
  $("goal-card").classList.toggle("hidden", !t.goal);
  $("exam-box").classList.toggle("hidden", !!t.exam);
  // The calendar offer: one click starts exam mode until the exam; it never starts by itself.
  $("offer").classList.toggle("hidden", !t.offer);
  if (t.offer) {
    const when = new Date(t.offer.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    $("offer-text").textContent = `${t.offer.title}, ${when}. Start exam mode until then? ` + (seeAll ? "" : EVERY_SITE_LINE);
    // The offered event is the exam: its start is fixed as exam mode's own time (QA round 3, N1).
    $("offer-start").onclick = async () => { await askEverySite(); await ask("startExam", { until: t.offer.start, at: t.offer.start, goal: t.offer.title, source: "calendar" }); show(); };
    $("offer-no").onclick = async () => { await ask("dismissOffer", { offer: t.offer }); show(); };
  }
  if (t.exam) { $("mode").textContent = `Exam mode until ${clock(t.exam.until)}`; $("mode").className = "pill closed"; }
  else if (blind && blind.length) { $("mode").textContent = "Can't see some sites"; $("mode").className = "pill warn"; }
  else if (t.waiting) { $("mode").textContent = "Change tomorrow"; $("mode").className = "pill warn"; }
  $("change").replaceChildren(chatIcon(), "Change something");
  // Withheld site access, said plainly with the one step that restores it (QA round 2 #3, "Make it visible").
  const old = document.getElementById("blind-today");
  if (old) old.remove();
  if (blind && blind.length) {
    $("rings").before(el("div", { class: "note", id: "blind-today" },
      el("span", {}, `Gatekeeper can't see ${blind.slice(0, 2).join(", ")}${blind.length > 2 ? ` and ${blind.length - 2} more` : ""}, so time there isn't counted and a closed site may open. To fix it, on Gatekeeper's page in ${extensionsPage()}, ${siteAccessHelp().words}. `),
      openAccessButton()));
  }
  // Exam mode without access to every site leaves sites Gatekeeper doesn't know open: said plainly (QA round 3, N3).
  for (const id of ["exam-open-today", "clock-today"]) { const x = document.getElementById(id); if (x) x.remove(); }
  if (t.exam && !seeAll) {
    const ask2 = el("button", { class: "link", type: "button" }, "Let Gatekeeper close them");
    ask2.addEventListener("click", async () => { await askEverySite(); show(); });
    $("rings").before(el("div", { class: "note", id: "exam-open-today" }, el("span", {}, "Sites Gatekeeper doesn't know stay open in this exam mode. "), ask2));
  }
  // The clock moved, or the computer slept: say that Gatekeeper is checking the time (QA round 3, first-run N1).
  if (state.clock && state.clock.held) {
    $("rings").before(el("div", { class: "note", id: "clock-today" }, el("span", {}, "Gatekeeper is checking the time with its server (your computer slept, or its clock moved). Until then, exam mode and changes waiting for the morning hold.")));
  }
}

// The watch week: minutes so far per kind, nothing blocked, and one tap to set limits now.
function showWatch(t) {
  $("mode").textContent = `Watch week · day ${t.watch.day} of ${t.watch.of}`;
  $("mode").className = "pill ok";
  const top = Math.max(30, ...t.watch.kinds.map((k) => k.used));
  $("rings").replaceChildren(...t.watch.kinds.slice(0, 6).map((k) => el("div", { class: "ring", "data-kind": k.kind },
    el("div", { class: "dial" },
      svg("svg", { width: 96, height: 96, viewBox: "0 0 96 96", role: "img", "aria-label": `${k.label}: ${k.used} minutes today` },
        svg("circle", { cx: 48, cy: 48, r: 40, fill: "none", class: "track", "stroke-width": 10 }),
        ...(k.used ? [svg("circle", { cx: 48, cy: 48, r: 40, fill: "none", class: "fill", "stroke-width": 10, "stroke-linecap": "round",
          "stroke-dasharray": `${Math.max(0.5, (k.used / top) * C)} ${C}`, transform: "rotate(-90 48 48)" })] : [])),
      el("div", { class: "count" }, String(k.used))),
    el("div", { class: "label" }, k.short), el("div", { class: "state" }, "min today"))));
  $("goal").textContent = t.goal;
  $("goal-card").classList.toggle("hidden", !t.goal);
  $("change").replaceChildren("Set limits now");
  $("change").onclick = async (e) => { e.preventDefault(); openTab("welcome.html?after=watch"); };
}

// Start exam mode from Today: it applies at once, and the rings lock.
$("exam-start").addEventListener("click", () => {
  $("exam-box").replaceChildren(examForm((r) => {
    if (r.ok) show().then(() => $("exam-box").classList.add("hidden"));
    else $("exam-box").append(el("div", { class: "small muted" }, r.refused === "bad_until" ? "Pick a time ahead." : "Not saved."));
  }, "today"));
  $("exam-until").focus();
});

$("all-rules").addEventListener("click", (e) => { e.preventDefault(); openTab("rules.html"); });
$("your-week").addEventListener("click", (e) => { e.preventDefault(); openTab("week.html"); });
checkWorker();
show();
