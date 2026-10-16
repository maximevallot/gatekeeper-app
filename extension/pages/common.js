// Shared by the pages: talking to the hands, and the words for times and minutes.

import { PROTOCOL } from "../protocol.js";

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
  const brave = extensionsPage().startsWith("brave");
  const out = [];
  if (incognito === false) {
    out.push(el("div", { class: "note", id: "incognito-warning" },
      `Private windows are not covered: any site opens there. To close that gap, open ${extensionsPage()}, click Details on Gatekeeper, and turn on "${brave ? "Allow in Private" : "Allow in Incognito"}".`));
  }
  if (blind.length) {
    out.push(el("div", { class: "note", id: "blind-warning" },
      `Gatekeeper's access to ${blind.slice(0, 3).join(", ")}${blind.length > 3 ? ` and ${blind.length - 3} more` : ""} was turned off, so it cannot count time there; those sites stay blocked until access is back. In ${extensionsPage()}, click Details on Gatekeeper and set Site access to "On specific sites".`));
  }
  for (const w of out) into.before(w);
  return out.length;
}
