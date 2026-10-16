# Gatekeeper

A browser extension for Chrome and Brave that gives each kind of distracting site a daily budget. When the minutes are used, every site of that kind closes until the next morning, and the gate shows what you said you're working toward. Tightening a rule applies at once; loosening one waits until the next morning. If you turn it on, the gate can talk back: say what you need a closed site for, and Claude may open it for a few minutes.

This is the product: anyone can install it, with no account. Maxime's personal version, with the Claude gate and exam mode on a local Python engine, is `~/gatekeeper` and is separate.

## What it does

**Milestone 1: budgets, entirely in the browser.**

- **Welcome tab**, opened on install: what pulls you away (social media, video, games, news, shopping), minutes a day for each (15 by default, 0 closes it all day), one sentence on what you're working toward, and optionally the two Claude switches below.
- **Gate**: closed, minutes used, when it reopens, and your sentence.
- **Rules page**: budgets per kind, your own sites counted against a kind, your goal, and the Claude switches. A change that loosens shows when it takes effect, and "Keep today's rules" cancels it.
- Time counts against a kind only while its tab and window are in front and you are there: input in the last minute, or something playing.
- A closed site is redirected to the gate before it loads, and blocked when embedded in another page. When a kind closes, every open tab of it goes to the gate. Time on a watched site playing sound counts in any window, including app windows and picture-in-picture.
- Time only goes forward: setting the clock back neither restores a budget nor stretches a pass, a timezone change does not start a new day, and a pass is used up by the seconds that pass while the browser runs.
- A site moved to another kind on the rules page follows the morning rule: to a kind with more time left, it waits.
- If site access is withheld for a watched site, that site is blocked rather than opened, and the rules page and a "!" badge say so. Private windows are not covered unless the user allows it; the welcome tab, the rules page and the gate say how.

**Milestone 2: Claude, through the relay.** Both are off until the user says yes.

- **The gate talks back.** One box: "Need it for something real?". Before the first message, the gate says what will be sent and asks *Yes, send it* or *No*. On allow, the one site asked for opens for the minutes Claude gave: at most 10, then 5, then 2 for the same kind in a day, then no more; after a pass the gate rests for 15 minutes. On ask, one follow-up, counted by the background worker. On no, the gate stays shut for 10 minutes. On the relay's daily limit it says so; on any other error it stays shut and says "Can't reach the gate right now".
- **Unknown sites are sorted.** When a site that is neither in the catalog nor one of yours has been in front for a minute, Claude is asked once which kind it is. The answer is kept on this device, and the site counts against that kind from then on. A failed sort is retried after an hour. Sorting needs the browser's permission to see every site, asked for when you turn it on.
- What is sent, to the [relay](../gatekeeper-relay) (which holds the Anthropic key and keeps none of it): for a gate message, the site's domain and kind, today's minutes and budget for that kind, your goal sentence, what you typed, and a random install number; for a sort, the domain, the page title and the install number. Never the page's path, its content, other tabs, or your other rules.

**Milestone 3: rules by chat, and YouTube video rules** (branch `rules-chat`; design in `~/brain/outputs/html/2026-10-16-gatekeeper-rules-by-talking.html`). Each is off until the user says yes.

- **The rules chat**, at the top of the rules page. Type or dictate what to change ("block YouTube videos about video games but keep educational ones"). The relay's `/rules` turns it into a list of operations; the engine applies them to a copy of the rules and runs `proposeRules`, so the card shows only what Apply will really do: what changes now, and what waits for the morning. Claude may ask one question instead. Nothing changes until Apply. Sent: the message, the chat's earlier turns, the rules last asked for, today's date and the install number; never usage.
- **Video rules** (`extension/engine/videos.js`): a rule in words about a kind of YouTube video, with an exception and its own daily time: 0 closes those videos, minutes give them their own budget, `null` makes them free. A matched video counts against its rule, never against Video. Only a clearly stricter change applies now; a new rule with time of its own or free waits for the morning, unless YouTube's own kind is not watched at all.
- **Judging a video** happens once per video ID: the hands ask YouTube's oEmbed address for the title and channel, then the relay's `/judge` (with the user's yes to "Judge videos with Claude") or the rule's word lists on the device. A judged video a rule closes is redirected before it loads; one a rule lets through stays reachable while YouTube itself is closed. A video opened from inside YouTube is caught by the next tick, so a newly seen video under a closing rule plays for a few seconds first.
- **Consent has versions** (`CONSENT` in the engine). A yes is kept with the version of the text agreed to; raising a version turns that switch off and the rules page says why. A yes given before versions counts as version 1.
- The gate does not argue with a video rule: it names the rule and points to the rules page.

## How it is built

| Part | Where | What it does |
| --- | --- | --- |
| The engine | `extension/engine/` | Rules, budgets, usage, the decision (allow, gate or block), next-morning loosening, passes and cooldowns, what a gate message or a sort sends and what its answer changes, and the catalog of sites by kind. No browser APIs and no network, so it can move to a server later unchanged. |
| The hands | `extension/hands/` | Report the tab in front every 2 seconds, keep the state in `chrome.storage.local`, write the redirect rules, open the gate, and make the only network calls, to the relay (`hands/relay.js`). They decide nothing. |
| The pages | `extension/pages/` | Welcome, gate, rules. |
| The relay's address | `extension/config.js` | One URL. `http://localhost:8787` for development. |

Rules are kinds plus budgets ("games: 15 min a day"), not lists of domains, so a new game counts against games without being named, and the same rules can drive an iPhone later, where Screen Time only exposes app categories.

Permissions: `storage`, `declarativeNetRequest` (a block holds even where site access is withheld), `idle`, `alarms`, host access to the catalog's sites and to the relay. Both are written into the manifest by `node scripts/sync-manifest.mjs` from the catalog and `config.js`, and a test fails if they drift. Seeing every site is optional, asked for when sorting is turned on, and given back when it is turned off; a site you add yourself is asked for one at a time. No content scripts, so nothing reads pages. The gate page is the one file web pages can reach, under a per-session address: a link to a closed site from any other site has to be able to land on it.

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

47 tests under node, no dependencies, including video rules and the chat in `test/videos.test.mjs`: the engine (budgets, loosening, passes, the gate's request and answer, sorting, and the QA findings of 2026-10-16 in `test/qa.test.mjs`), the redirect and block rules, and the manifest against the catalog.

```sh
npm run e2e
```

The whole extension against the real relay Worker under `wrangler dev`, with a fake Anthropic API and no key, in a throwaway headless Brave profile. A closed site's gate gets a pass and reopens the site; a game the catalog does not know (`mygame.localhost`, served locally) is sorted after a minute and then counts against games. It also checks that the Claude switches survive a page reload. It needs `~/gatekeeper-relay` with `npm install` done, Brave, and port 8787 free (or another in `RELAY_PORT`). The browser's permission prompt cannot be answered headless, so its test copy of the extension holds the all-sites permission from the start.

```sh
npm run e2e:qa
```

The QA findings that need a real browser: a watched site with access withheld is blocked and flagged, embedded players of a closed kind are blocked, every open tab of a kind goes to the gate when it closes, the private-window warnings show, and the welcome tab says nothing leaves the browser when Claude is off.

```sh
npm run e2e:videos
```

Milestone 3 in headless Brave: the chat turns the example sentence into a card, Apply makes two video rules, a game video goes to the gate and an educational one stays open, also once Video is closed for the day; Claude sees the title and channel and never the address; turning judging off forgets Claude's judgments. YouTube is a local HTTPS server that the browser resolves `www.youtube.com` to, so no real YouTube page is loaded. Needs `openssl`, Brave and the relay as for `npm run e2e`.

```sh
npm run e2e:stale
```

Today's pages beside milestone 1's background worker, the state Brave was in on 2026-10-16 when the unpacked extension had not been reloaded: the switches looked ticked and nothing was saved. Every page now asks the worker for its protocol (`extension/protocol.js`) and, if it does not match, says to reload Gatekeeper; a switch shows only what was saved. Bump `PROTOCOL` whenever a page starts sending a message an older worker would not know.

## Next

1. **Deploy the relay** (its README, "Steps left for Maxime": an Anthropic key, a Cloudflare account, `npm run deploy`).
2. **Swap in its address**: put the workers.dev URL in `extension/config.js`, run `node scripts/sync-manifest.mjs`, then `npm test`.
3. Once the extension has a fixed ID, set `ALLOWED_ORIGINS` on the relay to it.
4. Before the Chrome Web Store: the privacy policy draft still says goals, budgets and time never leave the browser, which the gate's request contradicts. See the launch claims L1, R1, R2 and C5 in `~/brain/outputs/gatekeeper-launch/`.
