# Gatekeeper

A browser extension for Chrome and Brave that gives each kind of distracting site a daily budget. When the minutes are used, every site of that kind closes until the next morning, and the gate shows what you said you're working toward. Tightening a rule applies at once; loosening one waits until the next morning. If you turn it on, the gate can talk back: say what you need a closed site for, and Claude may open it for a few minutes.

This is the product: anyone can install it, with no account. Maxime's personal version, with the Claude gate and exam mode on a local Python engine, is `~/gatekeeper` and is separate.

## What it does

**Milestone 1: budgets, entirely in the browser.**

- **Welcome tab**, opened on install: what pulls you away (social media, video, games, news, shopping), minutes a day for each (15 by default, 0 closes it all day), one sentence on what you're working toward, and optionally the two Claude switches below.
- **Gate**: closed, minutes used, when it reopens, and your sentence.
- **Rules page**: budgets per kind, your own sites counted against a kind, your goal, and the Claude switches. A change that loosens shows when it takes effect, and "Keep today's rules" cancels it.
- Time counts against a kind only while its tab and window are in front and you are there: input in the last minute, or something playing.
- A closed site is redirected to the gate before it loads.

**Milestone 2: Claude, through the relay.** Both are off until the user says yes.

- **The gate talks back.** One box: "Need it for something real?". Before the first message, the gate says what will be sent and asks *Yes, send it* or *No*. On allow, the whole kind opens for the minutes Claude gave (1 to 10), then the gate comes back. On ask, one follow-up. On no, the gate stays shut for 10 minutes. On any error, it stays shut and says "Can't reach the gate right now".
- **Unknown sites are sorted.** When a site that is neither in the catalog nor one of yours has been in front for a minute, Claude is asked once which kind it is. The answer is kept on this device, and the site counts against that kind from then on. A failed sort is retried after an hour. Sorting needs the browser's permission to see every site, asked for when you turn it on.
- What is sent, to the [relay](../gatekeeper-relay) (which holds the Anthropic key and keeps none of it): for a gate message, the site's domain and kind, today's minutes and budget for that kind, your goal sentence, what you typed, and a random install number; for a sort, the domain, the page title and the install number. Never the page's path, its content, other tabs, or your other rules.

## How it is built

| Part | Where | What it does |
| --- | --- | --- |
| The engine | `extension/engine/` | Rules, budgets, usage, the decision (allow, gate or block), next-morning loosening, passes and cooldowns, what a gate message or a sort sends and what its answer changes, and the catalog of sites by kind. No browser APIs and no network, so it can move to a server later unchanged. |
| The hands | `extension/hands/` | Report the tab in front every 2 seconds, keep the state in `chrome.storage.local`, write the redirect rules, open the gate, and make the only network calls, to the relay (`hands/relay.js`). They decide nothing. |
| The pages | `extension/pages/` | Welcome, gate, rules. |
| The relay's address | `extension/config.js` | One URL. `http://localhost:8787` for development. |

Rules are kinds plus budgets ("games: 15 min a day"), not lists of domains, so a new game counts against games without being named, and the same rules can drive an iPhone later, where Screen Time only exposes app categories.

Permissions: `storage`, `declarativeNetRequestWithHostAccess`, `idle`, `alarms`, host access to the catalog's sites and to the relay. Both are written into the manifest by `node scripts/sync-manifest.mjs` from the catalog and `config.js`, and a test fails if they drift. Seeing every site is optional, asked for when sorting is turned on, and given back when it is turned off; a site you add yourself is asked for one at a time. No content scripts, so nothing reads pages. The gate page is the one file web pages can reach, under a per-session address: a link to a closed site from any other site has to be able to land on it.

## Load it

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder. After a change, click the reload arrow on its card.

The welcome tab opens by itself on a fresh install. Clicking the toolbar icon opens your rules; its badge shows the minutes left on a watched site.

To try the Claude features before the relay is deployed, run it locally: in `~/gatekeeper-relay`, put a key in `.dev.vars` and run `npm run dev`. It listens on `localhost:8787`, the address in `config.js`.

## Test

```sh
npm test
```

25 tests under node, no dependencies: the engine (budgets, loosening, passes, the gate's request and answer, sorting), the redirect patterns, and the manifest against the catalog.

```sh
npm run e2e
```

The whole extension against the real relay Worker under `wrangler dev`, with a fake Anthropic API and no key, in a throwaway headless Brave profile. A closed site's gate gets a pass and reopens the site; a game the catalog does not know (`mygame.localhost`, served locally) is sorted after a minute and then counts against games. It also checks that the Claude switches survive a page reload. It needs `~/gatekeeper-relay` with `npm install` done, Brave, and port 8787 free (or another in `RELAY_PORT`). The browser's permission prompt cannot be answered headless, so its test copy of the extension holds the all-sites permission from the start.

```sh
npm run e2e:stale
```

Today's pages beside milestone 1's background worker, the state Brave was in on 2026-10-16 when the unpacked extension had not been reloaded: the switches looked ticked and nothing was saved. Every page now asks the worker for its protocol (`extension/protocol.js`) and, if it does not match, says to reload Gatekeeper; a switch shows only what was saved. Bump `PROTOCOL` whenever a page starts sending a message an older worker would not know.

## Next

1. **Deploy the relay** (its README, "Steps left for Maxime": an Anthropic key, a Cloudflare account, `npm run deploy`).
2. **Swap in its address**: put the workers.dev URL in `extension/config.js`, run `node scripts/sync-manifest.mjs`, then `npm test`.
3. Once the extension has a fixed ID, set `ALLOWED_ORIGINS` on the relay to it.
4. Before the Chrome Web Store: the privacy policy draft still says goals, budgets and time never leave the browser, which the gate's request contradicts. See the launch claims L1, R1, R2 and C5 in `~/brain/outputs/gatekeeper-launch/`.
