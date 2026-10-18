// Your week: minutes on watched sites per day against what was allowed, from history kept on this device.
import { weekSummary, baseline, watching } from "../engine/engine.js";
import { ask, el, checkWorker } from "./common.js";

const $ = (id) => document.getElementById(id);
const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`);
const date = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };

async function show() {
  const { state, now } = await ask("state");
  const w = weekSummary(state, now);
  const first = date(w.days[0].day), last = date(w.days[6].day);
  $("range").textContent = `Your week · ${first.toLocaleDateString([], { day: "numeric", month: "short" })} to ${last.toLocaleDateString([], { day: "numeric", month: "short" })}`;
  $("total").textContent = hm(w.minutes);
  $("allowed").textContent = w.allowed ? `on watched sites, of ${hm(w.allowed)} allowed` : "on watched sites";
  const perDay = Math.max(...w.days.map((d) => d.allowed || 0), 0);
  const top = Math.max(perDay, ...w.days.map((d) => d.minutes || 0), 1);
  $("limit-label").textContent = perDay ? `Limit ${perDay} a day` : "";
  $("bars").replaceChildren(
    ...w.days.map((d) => d.none
      ? el("div", { class: "bar none", title: "Not recorded" })
      : el("div", { class: "bar" + (d.watching ? " watch" : d.allowed && d.minutes > d.allowed ? " over" : ""), style: `height: ${Math.max(1, (d.minutes / top) * 100)}%`,
          title: `${d.weekday}: ${d.minutes} min`, "aria-label": `${d.weekday}: ${d.minutes} minutes` })),
    ...(perDay ? [el("div", { class: "limit", style: `bottom: ${(perDay / top) * 100}%` })] : []));
  $("days").replaceChildren(...w.days.map((d, i) => el("span", {}, i === 6 ? "Today" : d.weekday)));
  $("gates").textContent = String(w.gates);
  $("passes").textContent = String(w.passes);
  $("clear").textContent = String(w.clearDays);
  $("clear-label").textContent = w.clearDays === 1 ? "day nothing had to close" : "days nothing had to close";
  // After the watch week: the baseline, and the way to set limits from it.
  const ready = new URLSearchParams(location.search).get("ready") === "1" || (state.watch && !watching(state));
  if (ready && state.watch && !Object.keys(state.rules.kinds).length) {
    const b = baseline(state, now);
    $("ready-text").textContent = b.kinds.length
      ? "A day, on average: " + b.kinds.map((k) => `${k.label.toLowerCase()} ${k.perDay} min`).join(", ") + ". Nothing was blocked. Limits start from half of that, and you can change them."
      : "No time on these sites this week. You can still set limits for the kinds you want to keep an eye on.";
    $("ready").classList.remove("hidden");
    ask("watchShown").catch(() => {});
  }
  if (state.watch && watching(state)) $("limit-label").textContent = "Watch week: nothing blocked";
  if (w.loosenAsked) {
    $("note").before(el("p", { class: "muted", id: "loosen-week" }, `You asked to loosen a rule ${w.loosenAsked} time${w.loosenAsked === 1 ? "" : "s"}; Gatekeeper agreed ${w.loosenAllowed === 0 ? "none" : w.loosenAllowed === w.loosenAsked ? "every time" : w.loosenAllowed + " of them"}.`));
  }
  if (w.withheld) {
    // Withheld site access, kept in the history (QA round 2 #3, "Make it visible").
    const m = w.withheld.minutes, d = w.withheld.domains;
    const time = m >= 90 ? `${Math.round(m / 60)} h` : `${m} min`;
    $("note").before(el("p", { class: "muted", id: "withheld-week" }, `Access withheld for ${time} on ${d.slice(0, 2).join(", ")}${d.length > 2 ? ` and ${d.length - 2} more` : ""}.`));
  }
  if (w.examStarts) {
    $("note").before(el("p", { class: "muted", id: "exam-week" }, `Exam mode started ${w.examStarts} time${w.examStarts === 1 ? "" : "s"} this week.`));
  }
  $("note").textContent = w.keptDays < 7
    ? "Kept on this device only. The week fills in from the day this version was installed."
    : "Kept on this device only.";
}

checkWorker();
show();
