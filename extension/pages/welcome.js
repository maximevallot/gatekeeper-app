import { KINDS, KIND_ORDER } from "../engine/catalog.js";
import { DEFAULT_MINUTES, minutesText, label, baseline } from "../engine/engine.js";
import { ask, el, checkWorker, extensionsPage, privateToggle, stepper, whatsSentToggle } from "./common.js";

// One Gatekeeper per person (0.3.0): finishing the welcome makes the account, and the page says so plainly.
const ACCOUNT_LINE = "Finishing makes your Gatekeeper account on Gatekeeper's server: your rules, your goal, today's minutes per kind, exam mode and your talk with Gatekeeper are kept there, so your other devices can join and follow the same rules. Never the pages you visit. You can leave or delete it in your rules.";
const ACCOUNT_DONE = "Your Gatekeeper account holds your rules, today's minutes and your talk with Gatekeeper, so your other devices can join it: open your rules, then Your Gatekeeper › Add a device. Never the pages you visit.";
for (const p of document.querySelectorAll(".account-line")) p.textContent = ACCOUNT_LINE;

const $ = (id) => document.getElementById(id);
const picked = new Set();
let minutes = DEFAULT_MINUTES;

const afterWatch = new URLSearchParams(location.search).get("after") === "watch";

for (const kind of KIND_ORDER) {
  const chip = el("button", { class: "choice kind", type: "button", "aria-pressed": "false", "data-kind": kind }, KINDS[kind].label);
  chip.addEventListener("click", () => {
    if (picked.has(kind)) picked.delete(kind); else picked.add(kind);
    chip.setAttribute("aria-pressed", String(picked.has(kind)));
    $("start").disabled = picked.size === 0;
  });
  $("kinds").append(chip);
}

const minutesStepper = stepper({ value: minutes, big: true, max: 240, onChange: (m) => { minutes = m; } });
$("minutes").append(minutesStepper);

// The watch week: count only, block nothing, for seven days. "Skip" goes straight to the three questions.
$("skip-watch").addEventListener("click", () => {
  $("goal").value = $("watch-goal").value;
  $("watch").classList.add("hidden");
  $("ask").classList.remove("hidden");
});

$("start-watch").addEventListener("click", async () => {
  $("start-watch").disabled = true;
  await ask("watch", { goal: $("watch-goal").value });
  $("done-title").textContent = "You're watching";
  $("summary").textContent = "For the next 7 days nothing is blocked. Gatekeeper's toolbar button shows the time so far, and you can set limits early from there.";
  $("done-privacy").textContent = ACCOUNT_DONE;
  $("watch").classList.add("hidden");
  $("join-card").classList.add("hidden");
  $("done").classList.remove("hidden");
  checkPrivate();
});

// After the watch week: the questions start from what the week showed.
async function fromWatch() {
  const { state, now } = await ask("state");
  const b = baseline(state, now);
  $("watch").classList.add("hidden");
  $("ask").classList.remove("hidden");
  $("ask-title").textContent = "Set limits from your week";
  $("ask-lead").textContent = b.kinds.length
    ? "Last week, a day: " + b.kinds.map((k) => `${k.label.toLowerCase()} ${k.perDay} min`).join(", ") + ". Here's a start at half."
    : "Your week showed no time on these sites. Pick what you want to keep an eye on.";
  $("goal").value = state.goal || "";
  for (const k of b.kinds) $("kinds").querySelector(`[data-kind=${k.kind}]`).click();
  if (b.kinds.length) {
    minutes = Math.max(...b.kinds.map((k) => k.suggested));
    minutesStepper.set(minutes);
  }
}
if (afterWatch) fromWatch();

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
  $("done-privacy").textContent = (on ? "Claude help is on: only what you asked it for is sent, and only when it's needed. " : "") + ACCOUNT_DONE;
  $("join-card").classList.add("hidden");
  if (!saved || on !== help) {
    $("done-error").textContent = "Claude help wasn't saved. You can turn it on in your rules.";
    $("done-error").classList.remove("hidden");
  }
  $("ask").classList.add("hidden");
  $("done").classList.remove("hidden");
  checkPrivate();
});

// "Already use Gatekeeper?": join the account another device shows a code for.
$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("join-code").value.replace(/\D/g, "");
  if (code.length !== 6) { showJoinError("The code has 6 digits."); return; }
  $("join-go").disabled = true;
  const r = await ask("joinAccount", { code }).catch(() => ({ error: "unreachable" }));
  $("join-go").disabled = false;
  if (r.error) {
    showJoinError(r.error === "bad_code" ? "That code is wrong, used or older than 10 minutes. Ask your other device for a new one."
      : r.error === "unreachable" ? "Gatekeeper's server can't be reached. Check your connection and try again." : "That didn't work. Try a new code.");
    return;
  }
  joined(r.merged);
});
function showJoinError(text) { $("join-error").textContent = text; $("join-error").classList.remove("hidden"); }

async function joined(merged) {
  const { state } = await ask("state");
  for (const id of ["join-card", "watch", "ask"]) $(id).classList.add("hidden");
  $("done-title").textContent = "You're in your Gatekeeper";
  $("summary").textContent = Object.entries(state.rules.kinds).map(([k, v]) => `${label(k)}: ${minutesText(v.minutes)}`).join(". ") + (Object.keys(state.rules.kinds).length ? "." : "No limits yet.");
  $("done-privacy").textContent = ACCOUNT_DONE;
  if (merged && merged.rulesDiffer) {
    // The account's set stays whole; this device's set goes through the agent like any loosening (decided 2026-10-18).
    $("join-choice-text").textContent = "This browser had rules of its own. Your Gatekeeper's rules apply here now; this browser's are kept for 30 days. Using them instead is a rule change: stricter parts apply at once, looser ones ask Gatekeeper why.";
    $("join-choice").classList.remove("hidden");
    $("use-account").onclick = () => $("join-choice").classList.add("hidden");
    $("use-device").onclick = async () => {
      const r = await ask("propose", { rules: merged.lostRules });
      $("join-choice-text").textContent = r.needsOk ? "The stricter parts apply now. To loosen the rest, open your rules and tell Gatekeeper why."
        : r.later && r.later.length ? "The stricter parts apply now; the rest tomorrow morning." : "Done: this browser's rules apply.";
      $("use-account").classList.add("hidden"); $("use-device").classList.add("hidden");
    };
  }
  $("done").classList.remove("hidden");
  checkPrivate();
}

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
