// Today, in the toolbar popup: a ring per watched kind (minutes left, or a lock when closed), the goal, and
// the way to change something.
import { todaySummary } from "../engine/engine.js";
import { ask, el, svg, lockIcon, chatIcon, clock, checkWorker } from "./common.js";

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
    : el("div", { class: "state closed" }, k.status === "closed" ? "all day" : `till ${clock(reopensAt)}`);
  return el("div", { class: "ring", "data-kind": k.kind }, dial, el("div", { class: "label" }, k.short), state);
}

async function show() {
  const { state, now, blind } = await ask("state");
  const t = todaySummary(state, now);
  if (!t.setupDone) {
    $("rings").replaceChildren(el("p", { class: "lead", style: "grid-column: 1 / -1" }, "Gatekeeper isn't set up yet. It takes a minute."));
    $("change").replaceChildren("Set it up");
    $("change").onclick = (e) => { e.preventDefault(); openTab("welcome.html"); };
    return;
  }
  $("rings").replaceChildren(...(t.kinds.length ? t.kinds.map((k) => ring(k, t.reopensAt))
    : [el("p", { class: "lead", style: "grid-column: 1 / -1" }, "Nothing is watched yet.")]));
  $("goal").textContent = t.goal;
  $("goal-card").classList.toggle("hidden", !t.goal);
  if (blind && blind.length) { $("mode").textContent = "Check site access"; $("mode").className = "pill warn"; }
  else if (t.waiting) { $("mode").textContent = "Change tomorrow"; $("mode").className = "pill warn"; }
  $("change").replaceChildren(chatIcon(), "Change something");
}

$("all-rules").addEventListener("click", (e) => { e.preventDefault(); openTab("rules.html"); });
$("your-week").addEventListener("click", (e) => { e.preventDefault(); openTab("week.html"); });
checkWorker();
show();
