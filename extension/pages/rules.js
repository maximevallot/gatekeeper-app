import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, label } from "../engine/engine.js";
import { ask, el, when } from "./common.js";

const $ = (id) => document.getElementById(id);
let draft = null; // the rules being edited: { kinds, sites, dayStart }

async function load() {
  const { state, now } = await ask("state");
  draft = structuredClone(state.pending ? state.pending.rules : state.rules);
  $("goal").value = state.goal || "";
  renderPending(state, now);
  renderKinds(state);
  renderSites();
}

function renderPending(state, now) {
  const p = state.pending;
  $("pending").classList.toggle("hidden", !p);
  if (!p) return;
  $("pending").replaceChildren(
    `Waiting until ${when(p.from, now)}: your changes that loosen a rule. Until then, today's rules hold. `,
    el("button", { class: "link", type: "button", onclick: keepToday }, "Keep today's rules"));
}

async function keepToday() {
  const { state } = await ask("state");
  await ask("propose", { rules: state.rules });
  flash("Kept today's rules. Nothing is waiting.");
  load();
}

function renderKinds(state) {
  const inForce = state.rules.kinds;
  $("kinds").replaceChildren(...KIND_ORDER.map((kind) => {
    const on = !!draft.kinds[kind];
    const box = el("input", { type: "checkbox", "data-kind": kind, "aria-label": "Watch " + KINDS[kind].label });
    box.checked = on;
    const minutes = el("input", { type: "number", min: "0", max: "600", step: "5", "data-kind": kind,
      value: String(on ? draft.kinds[kind].minutes : DEFAULT_MINUTES) });
    minutes.disabled = !on;
    box.addEventListener("change", () => {
      if (box.checked) draft.kinds[kind] = { minutes: Number(minutes.value) || 0 };
      else delete draft.kinds[kind];
      minutes.disabled = !box.checked;
    });
    minutes.addEventListener("input", () => { if (draft.kinds[kind]) draft.kinds[kind].minutes = Math.max(0, Number(minutes.value) || 0); });
    const used = Math.floor(((state.usage.seconds || {})[kind] || 0) / 60);
    const now = inForce[kind] ? `${used} of ${inForce[kind].minutes} min used today` : "not watched today";
    return el("div", { class: "row" }, box,
      el("div", { class: "name" }, el("div", {}, KINDS[kind].label), el("div", { class: "muted" }, now)),
      minutes, el("span", { class: "muted" }, "min a day"));
  }));
  $("new-kind").replaceChildren(...KIND_ORDER.map((k) => el("option", { value: k }, KINDS[k].label)));
}

function renderSites() {
  const entries = Object.entries(draft.sites || {}).sort();
  $("sites").replaceChildren(...(entries.length ? entries.map(([domain, kind]) =>
    el("div", { class: "row" }, el("div", { class: "name" }, domain), el("span", { class: "muted" }, label(kind)),
      el("button", { class: "link", type: "button", onclick: () => { delete draft.sites[domain]; renderSites(); } }, "Remove")))
    : [el("p", { class: "muted" }, "None yet.")]));
}

$("add-site").addEventListener("click", () => {
  let d = $("new-site").value.trim().toLowerCase();
  try { d = new URL(d.includes("://") ? d : "https://" + d).hostname.replace(/^www\./, ""); } catch { return; }
  if (!d.includes(".")) return;
  const kind = $("new-kind").value;
  // Gatekeeper may act only on the sites in its catalog; any other site is asked for here, one at a time,
  // and the browser asks the user. The request has to start inside the click.
  chrome.permissions.request({ origins: [`*://*.${d}/*`] }).then((granted) => {
    if (!granted) {
      flash(`Gatekeeper needs access to ${d} to count time there and close it. Nothing was added.`);
      return;
    }
    draft.sites = { ...(draft.sites || {}), [d]: kind };
    $("new-site").value = "";
    renderSites();
    flash(`${d} will count as ${label(kind).toLowerCase()} once you save.`);
  });
});

function flash(text, list = []) {
  $("result").replaceChildren(text, ...(list.length ? [el("ul", { class: "changes" }, ...list.map((t) => el("li", {}, t)))] : []));
  $("result").classList.remove("hidden");
}

$("save").addEventListener("click", async () => {
  const r = await ask("propose", { rules: draft, goal: $("goal").value });
  const parts = [];
  if (r.now.length) parts.push("Applied now: " + r.now.map((c) => c.text).join("; ") + ".");
  if (r.later.length) parts.push(`Takes effect ${when(r.from)}: ` + r.later.map((c) => c.text).join("; ") + ".");
  flash(parts.join(" ") || "Saved.");
  load();
});

load();
