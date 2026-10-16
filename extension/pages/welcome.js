import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, minutesText, label } from "../engine/engine.js";
import { ask, el, checkWorker, extensionsPage } from "./common.js";

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
  $("claude-card").classList.toggle("hidden", !any);
  $("private-card").classList.toggle("hidden", !any);
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
  const wanted = { talk: $("talk").checked, sorting: $("sorting").checked };
  const saved = await ask("consent", wanted).catch(() => null);
  const on = saved ? [saved.talk && "the gate's messages", saved.sorting && "unknown sites' names and titles"].filter(Boolean) : [];
  // Say what actually leaves the browser, from what was saved, not from what was ticked.
  $("done-privacy").textContent = "Gatekeeper only counts time while the tab is in front and you are there. " + (on.length
    ? `Only ${on.join(" and ")} go to Gatekeeper's relay and Claude, as you allowed; everything else stays in this browser.`
    : "Nothing leaves this browser.");
  if (!saved || saved.talk !== wanted.talk || saved.sorting !== wanted.sorting) {
    $("done-error").textContent = "The Claude switches were not saved. You can turn them on in your rules.";
    $("done-error").classList.remove("hidden");
  }
  $("summary").textContent = Object.entries(kinds).map(([k, m]) => `${label(k)}: ${minutesText(m)}`).join(". ") + ".";
  $("ask").classList.add("hidden");
  $("done").classList.remove("hidden");
});

$("sorting").addEventListener("change", () => {
  if (!$("sorting").checked) return;
  // The browser asks; the request has to start inside the click.
  chrome.permissions.request({ origins: ["*://*/*"] }).then((granted) => { $("sorting").checked = granted; });
});

checkWorker();

// Private windows: extensions are off there unless the user allows it, and every site would open.
async function checkPrivate() {
  const { incognito } = await ask("state").catch(() => ({}));
  const brave = extensionsPage().startsWith("brave");
  $("private-text").textContent = incognito
    ? "Gatekeeper also works in private windows. Nothing to do."
    : `Gatekeeper is off in private windows, so any site opens there. Open ${extensionsPage()}, click Details on Gatekeeper, and turn on "${brave ? "Allow in Private" : "Allow in Incognito"}". Then check again.`;
  $("private-check").classList.toggle("hidden", !!incognito);
}
$("private-check").addEventListener("click", checkPrivate);
checkPrivate();
