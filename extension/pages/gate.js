// The gate: no chat in milestone 1. It says what is closed, how much was used, when it reopens, and
// the user's own sentence about what they are working toward.
import { ask, when } from "./common.js";

const $ = (id) => document.getElementById(id);
const url = location.hash.slice(1); // the page that was stopped, exactly as it was asked for

async function show() {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  const { decision: d, goal } = await ask("decide", { url });
  if (d.verdict === "allow" && /^https?:/.test(url)) {
    location.replace(url); // reopened since (a new morning): go back to the page
    return;
  }
  document.title = `${d.label || host} closed`;
  $("site").textContent = d.label ? `${host} · ${d.label}` : host;
  if (d.verdict === "block") {
    $("headline").textContent = "Closed all day";
    $("used").textContent = `You set ${d.label.toLowerCase()} to 0 minutes. It stays closed until you change that rule, which takes effect the next morning.`;
  } else {
    $("headline").textContent = "Closed for today";
    const m = d.budgetMinutes;
    $("used").textContent = `You used your ${m} minute${m === 1 ? "" : "s"}. It opens again ${when(d.reopensAt)}.`;
  }
  $("goal").textContent = goal || "";
  $("goal-box").classList.toggle("hidden", !goal);
  $("rules-link").href = chrome.runtime.getURL("pages/rules.html");
  $("closed").classList.remove("hidden");
}

show();
