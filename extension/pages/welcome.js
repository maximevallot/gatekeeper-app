import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, minutesText, label } from "../engine/engine.js";
import { ask, el } from "./common.js";

const picked = new Map(); // kind -> minutes
const $ = (id) => document.getElementById(id);

const examples = (kind) => KINDS[kind].examples + "…";

for (const kind of KIND_ORDER) {
  const card = el("button", { class: "kind", "aria-pressed": "false", "data-kind": kind, type: "button" },
    el("b", {}, KINDS[kind].label), el("span", {}, examples(kind)));
  card.addEventListener("click", () => {
    if (picked.has(kind)) picked.delete(kind); else picked.set(kind, DEFAULT_MINUTES);
    card.setAttribute("aria-pressed", String(picked.has(kind)));
    render();
  });
  $("kinds").append(card);
}

function render() {
  const any = picked.size > 0;
  $("budgets-card").classList.toggle("hidden", !any);
  $("goal-card").classList.toggle("hidden", !any);
  $("start").disabled = !any;
  $("budgets").replaceChildren(...KIND_ORDER.filter((k) => picked.has(k)).map((kind) => {
    const input = el("input", { type: "number", min: "0", max: "600", step: "5", value: String(picked.get(kind)),
      "data-kind": kind, "aria-label": KINDS[kind].label + " minutes a day" });
    input.addEventListener("input", () => picked.set(kind, Math.max(0, Number(input.value) || 0)));
    return el("div", { class: "row" }, el("div", { class: "name" }, KINDS[kind].label), input, el("span", { class: "muted" }, "min a day"));
  }));
}

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  const kinds = Object.fromEntries(picked);
  await ask("setup", { kinds, goal: $("goal").value });
  $("summary").textContent = Object.entries(kinds).map(([k, m]) => `${label(k)}: ${minutesText(m)}`).join(". ") + ".";
  $("ask").classList.add("hidden");
  $("done").classList.remove("hidden");
});
