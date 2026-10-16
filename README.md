# Gatekeeper

A browser extension for Chrome and Brave that gives each kind of distracting site a daily budget. When the minutes are used, every site of that kind closes until the next morning, and the gate shows what you said you're working toward. Tightening a rule applies at once; loosening one waits until the next morning.

This is the product: anyone can install it, with no account and nothing to run. Maxime's personal version, with the Claude gate and exam mode on a local Python engine, is `~/gatekeeper` and is separate.

## Milestone 1 (this)

No network calls, no accounts, no money. Everything stays in the browser.

- **Welcome tab**, opened on install: what pulls you away (social media, video, games, news, shopping), minutes a day for each (15 by default, 0 closes it all day), and one sentence on what you're working toward.
- **Gate**: closed, minutes used, when it reopens, and your sentence. No chat yet.
- **Rules page**: budgets per kind, your own sites counted against a kind, your goal. A change that loosens shows when it takes effect, and "Keep today's rules" cancels it.
- Time counts against a kind only while its tab and window are in front and you are there: input in the last minute, or something playing.
- A closed site is redirected to the gate before it loads. A site that is not in the catalog and not one of yours is allowed.

## How it is built

| Part | Where | What it does |
| --- | --- | --- |
| The engine | `extension/engine/` | Rules, budgets, usage, the decision (allow, gate or block), next-morning loosening, and the catalog of sites by kind. No browser APIs, so it can move to a server later unchanged. |
| The hands | `extension/hands/` | Report the tab in front every 2 seconds, keep the state in `chrome.storage.local`, write the redirect rules, open the gate. They decide nothing. |
| The pages | `extension/pages/` | Welcome, gate, rules. |

Rules are kinds plus budgets ("games: 15 min a day"), not lists of domains, so agar.io counts against games without being named, and the same rules can drive an iPhone later, where Screen Time only exposes app categories.

Permissions: `storage`, `declarativeNetRequest`, `idle`, `alarms`, and access to all sites, needed to read the front tab's address and to redirect a closed site.

## Load it

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.

The welcome tab opens by itself. Clicking the toolbar icon opens your rules; its badge shows the minutes left on a watched site.

## Test

```sh
npm test
```

The engine and blocker tests run under node with no dependencies. The whole journey was also checked in a throwaway headless Brave profile, from a fresh install through the welcome tab to the first gate. `docs/` holds screenshots from that run.

## Next

- **Milestone 2:** a small relay that holds the Anthropic API key with a per-user cap, so the gate can talk back and Claude can sort unknown sites. Claude subscriptions cannot be used by third-party apps; "Sign in with ChatGPT" may come later.
- Exam mode that offers itself before deadlines, the Mac helper (hides Mail and Slack, closes other browsers), then the iPhone.
