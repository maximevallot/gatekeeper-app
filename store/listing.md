# Chrome Web Store listing, version 0.1.1

Copy-paste text for the developer dashboard, matching what the extension does today. The longer drafts, with notes for a lawyer, are in `~/brain/outputs/gatekeeper-launch/`.

## Store listing tab

**Description**

Gatekeeper is for people who know what they should be doing and drift anyway.

You don't list websites. You give each kind of site a daily budget: social media 15 minutes, video 20, games none. When the budget runs out, Gatekeeper closes the site before the page loads and shows your own goal instead. It counts only the time you actually spend there: tab in front, window in focus, and you at the keyboard or a video playing.

The rule you can't talk yourself out of at 11 pm: you can tighten a rule any time, but loosening one only takes effect the next morning.

Social media, video, games, news and shopping come with a list of common sites, and you can add your own.

Two optional AI features, both off until you turn them on:
- A gate that talks back. When a budget is used up, say what you need the site for. Claude may give you a few minutes for a real need, or say no.
- Sorting sites Gatekeeper doesn't know. After a minute on a new site, Claude says which kind it is, so a new game counts as a game.

Private windows: turn on "Allow in Incognito" (Brave: "Allow in Private") for Gatekeeper, or any site opens there. The welcome tab shows how.

Your data: your rules, budgets and history stay in your browser. Gatekeeper never reads page content. The AI features send only what they need, and only after you say yes: for a message at the gate, the site's name and kind, today's minutes and budget for that kind, your goal sentence and what you type; for sorting, a new site's name and page title. Nothing is sold or used for advertising.

Privacy policy: https://gatekeeper-relay.mvallot22.workers.dev/privacy
Questions: mvallot22@gmail.com

**Category:** Productivity → Workflow & Planning (or the closest Productivity subcategory offered)

**Language:** English

**Images:** `icon128.png`, `promo-small-440x280.png`, `screenshot-1-welcome.png`, `screenshot-2-gate.png`, `screenshot-3-rules.png` (all in this folder)

## Privacy practices tab

**Single purpose**

Limit the time you spend on distracting websites. You give each kind of site a daily budget; when it is used up, the extension closes the site before it loads. Counting time, sorting unknown sites into a kind, and the optional gate that answers a request for more time all serve that one purpose.

**Permission justifications**

- `storage`: Keeps the user's rules, daily budgets, minutes used and pending rule changes in the browser.
- `declarativeNetRequest`: Closes a site whose daily budget is used up: redirects it to the extension's gate page before the page loads, and blocks it when it is embedded in another page or when the user has withheld the extension's access to that site, so turning off site access cannot reopen it.
- `idle`: Counts time only while the user is active, so an idle tab does not use up the budget.
- `alarms`: Resets budgets each day and applies a loosened rule the next morning.
- Host permissions (the built-in list of social, video, game, news and shopping sites, and the extension's relay): Needed to close those sites when their budget is used up, and to reach the relay for the optional AI features.
- Optional host permission for all sites: Requested only when the user turns on "Sort sites Gatekeeper doesn't know", so a site outside the built-in list can be identified and counted. Gatekeeper never reads page content.

**Remote code:** No, I am not using remote code. (The AI's reply is text shown on the gate page; it is never executed.)

**Data usage, what to tick:**
- Web history: yes (the domain of the site, sent only by the optional AI features).
- Website content: yes (the page title, sent only when sorting an unknown site).
- Personal communications: yes (the message typed at the gate).
- Location: yes (the relay uses the network address, which Google lists under Location, to cap daily use per network).
- User activity: no (activity is checked only to count time, on the device).
- Everything else: no.
- Tick all three certifications.

**Privacy policy URL:** https://gatekeeper-relay.mvallot22.workers.dev/privacy

## Distribution tab

- Payments: free.
- Visibility: **Unlisted** (only people with the link can install it).
- Regions: all.

## Account tab

- Contact email: mvallot22@gmail.com (verified).
- Trader status: non-trader while Gatekeeper is free. Switch to trader before charging anyone.
