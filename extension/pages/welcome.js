import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, minutesText, label } from "../engine/engine.js";
import { ask, el, checkWorker, extensionsPage, privateToggle, stepper, whatsSentToggle } from "./common.js";

const $ = (id) => document.getElementById(id);
const picked = new Set();
let minutes = DEFAULT_MINUTES;

for (const kind of KIND_ORDER) {
  const chip = el("button", { class: "choice kind", type: "button", "aria-pressed": "false", "data-kind": kind }, KINDS[kind].label);
  chip.addEventListener("click", () => {
    if (picked.has(kind)) picked.delete(kind); else picked.add(kind);
    chip.setAttribute("aria-pressed", String(picked.has(kind)));
    $("start").disabled = picked.size === 0;
  });
  $("kinds").append(chip);
}

$("minutes").append(stepper({ value: minutes, big: true, max: 240, onChange: (m) => { minutes = m; } }));

const sent = whatsSentToggle();
$("help-line").append(" ", sent.link);
$("help-line").after(sent.list);

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  const help = $("help").checked;
  // Sorting new sites needs to see every site: the browser asks now, inside the click.
  const permission = help ? chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false) : Promise.resolve(false);
  const kinds = Object.fromEntries([...picked].map((k) => [k, minutes]));
  await ask("setup", { kinds, goal: $("goal").value });
  await permission;
  const saved = await ask("consent", { help }).catch(() => null);
  const on = !!(saved && saved.help);
  $("summary").textContent = Object.entries(kinds).map(([k, m]) => `${label(k)}: ${minutesText(m)}`).join(". ") + ".";
  // Say what actually leaves the browser, from what was saved, not from what was ticked.
  $("done-privacy").textContent = on
    ? "Claude help is on: only what you asked it for is sent, and only when it's needed. Everything else stays in this browser."
    : "Nothing leaves this browser.";
  if (!saved || on !== help) {
    $("done-error").textContent = "Claude help wasn't saved. You can turn it on in your rules.";
    $("done-error").classList.remove("hidden");
  }
  $("ask").classList.add("hidden");
  $("done").classList.remove("hidden");
  checkPrivate();
});

// Private windows: extensions are off there unless the user allows it, and every site would open.
async function checkPrivate() {
  const { incognito } = await ask("state").catch(() => ({}));
  $("private-text").textContent = incognito
    ? "Gatekeeper also works in private windows. Nothing to do."
    : `Any site opens in a private window until you allow Gatekeeper there: open ${extensionsPage()}, click Details on Gatekeeper, and turn on "${privateToggle()}".`;
  $("private-check").classList.toggle("hidden", !!incognito);
}
$("private-check").addEventListener("click", checkPrivate);

checkWorker();
