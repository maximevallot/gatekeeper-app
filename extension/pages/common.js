// Shared by the pages: talking to the hands, and the words for times and minutes.

import { PROTOCOL } from "../protocol.js";
import { WHATS_SENT, SENT_TO } from "../engine/engine.js";

export function ask(type, body = {}) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage({ type, ...body }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (res && res.error && !("decision" in res)) reject(new Error(res.error));
      else resolve(res);
    }));
}

/** "tomorrow at 4:00", "today at 4:00", or "Tue 21 Oct at 4:00". */
export function when(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(n)) / 86400e3);
  if (diff === 0) return "today at " + time;
  if (diff === 1) return "tomorrow at " + time;
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " at " + time;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

/**
 * Make sure the background worker speaks this page's protocol. If it does not (an old worker still running
 * beside newer pages), say so at the top of the page and return false.
 */
export async function checkWorker() {
  let r = null;
  try { r = await Promise.race([ask("hello"), new Promise((res) => setTimeout(() => res(null), 3000))]); } catch {}
  if (r && r.protocol === PROTOCOL) return true;
  const where = navigator.userAgentData && navigator.userAgentData.brands.some((b) => /Brave/i.test(b.brand)) ? "brave://extensions" : "chrome://extensions";
  document.querySelector("main").prepend(el("div", { class: "note", id: "stale" },
    `Gatekeeper was updated but is still running its old version, so changes here are not saved. Open ${where} and click the reload arrow on Gatekeeper.`));
  return false;
}

/** Where the browser keeps its extension settings, for instructions. */
export function extensionsPage() {
  const brave = navigator.userAgentData && navigator.userAgentData.brands.some((b) => /Brave/i.test(b.brand));
  return brave ? "brave://extensions" : "chrome://extensions";
}

/**
 * Lasting warnings: private windows the extension cannot reach, and watched sites whose access was
 * withheld. `into` is the element they go before.
 */
export function warnings({ incognito, blind = [] }, into) {
  const out = [];
  if (incognito === false) {
    out.push(el("div", { class: "note", id: "incognito-warning" },
      el("span", {}, `Private windows aren't covered. In ${extensionsPage()}, open Gatekeeper's Details and turn on "${privateToggle()}".`)));
  }
  if (blind.length) {
    out.push(el("div", { class: "note", id: "blind-warning" },
      el("span", {}, `Gatekeeper can't see ${blind.slice(0, 2).join(", ")}${blind.length > 2 ? ` and ${blind.length - 2} more` : ""}, so they stay blocked. In ${extensionsPage()}, set Gatekeeper's Site access to "On specific sites".`)));
  }
  for (const w of out) into.before(w);
  return out.length;
}

/** The name of the switch that lets an extension run in private windows. */
export function privateToggle() {
  return extensionsPage().startsWith("brave") ? "Allow in Private" : "Allow in Incognito";
}

// ---------- small pieces of the design ----------

const SVG = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

export function lockIcon(size = 16, cls = "lock") {
  return svg("svg", { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("rect", { x: 5, y: 11, width: 14, height: 9, rx: 2, fill: "none", class: cls, "stroke-width": 2 }),
    svg("path", { d: "M8 11V8a4 4 0 0 1 8 0v3", fill: "none", class: cls, "stroke-width": 2 }));
}

export function clockIcon(size = 16) {
  return svg("svg", { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("circle", { cx: 12, cy: 12, r: 8, fill: "none", stroke: "currentColor", "stroke-width": 2 }),
    svg("path", { d: "M12 8v4l3 2", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }));
}

export function chatIcon() {
  return svg("svg", { width: 20, height: 20, viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("path", { d: "M4 5h16v11H9l-5 4z", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round" }));
}

/** "4:00" */
export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function minutesLabel(m) {
  return m === 0 ? "Closed" : `${m} min`;
}

/** A − value + stepper. `onChange(next)` is called with the new value; `format` turns it into text. */
export function stepper({ value, min = 0, max = 600, step = 5, label, format = minutesLabel, big = false, onChange }) {
  let v = value;
  const shown = el("div", { class: "value", "aria-live": "polite" });
  const less = el("button", { type: "button", "aria-label": `Fewer minutes${label ? " for " + label : ""}`, "data-step": "-1" }, "−");
  const more = el("button", { type: "button", "aria-label": `More minutes${label ? " for " + label : ""}`, "data-step": "1" }, "+");
  const paint = () => {
    shown.textContent = format(v);
    shown.classList.toggle("closed", v === 0);
    less.disabled = v <= min;
    more.disabled = v >= max;
  };
  const go = (d) => { const n = Math.min(max, Math.max(min, v + d * step)); if (n !== v) { v = n; paint(); onChange && onChange(v); } };
  less.addEventListener("click", () => go(-1));
  more.addEventListener("click", () => go(1));
  paint();
  const box = el("div", { class: "stepper" + (big ? " big" : "") }, less, shown, more);
  box.set = (n) => { v = n; paint(); };
  return box;
}

/** The full list of what "Claude help" sends, word for word what the user agrees to. */
export function whatsSent() {
  return el("div", { class: "sent" },
    el("ul", {}, ...WHATS_SENT.map((w) => el("li", {}, el("b", {}, w.what + ": "), w.sent + ", " + w.when + "."))),
    el("p", {}, SENT_TO));
}

/** A "What's sent" link that opens the list in place. */
export function whatsSentToggle() {
  const list = whatsSent();
  list.classList.add("hidden");
  const link = el("button", { class: "link", type: "button", "aria-expanded": "false" }, "What's sent");
  link.addEventListener("click", () => {
    const open = list.classList.toggle("hidden") === false;
    link.setAttribute("aria-expanded", String(open));
  });
  return { link, list };
}

// ---------- appearance ----------

export function getAppearance() {
  try { return localStorage.getItem("gk-appearance") || "light"; } catch { return "light"; }
}

export function setAppearance(choice) {
  try { localStorage.setItem("gk-appearance", choice); } catch {}
  const dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
