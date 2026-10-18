// Turns the engine's enforcement into declarativeNetRequest rules. Adapted from the personal prototype
// (~/gatekeeper, commit f2984cc), with the gate inside the extension instead of on a local server.
//
// redirect (priority 2, top-level pages): a closed site goes to the gate page before it loads, with its own
//   URL after the "#", so nothing of it renders. A redirect fires only where the extension has access to
//   the site.
// block (priority 1, top-level pages and frames): the same sites, for embedded players, and for a site
//   whose access was withheld, where the redirect cannot fire; plus watched sites Gatekeeper cannot see.
//   A block needs no access to the site, so taking access away does not open it.
// allowVideos (priority 3, top-level pages): a YouTube video a video rule lets through, loaded directly
//   while YouTube itself is closed. closeVideos (priority 2): a video a video rule closes, sent to the gate
//   before it loads. Videos opened from inside YouTube never load a page; the tick catches those.
// examAll (exam mode, with access to every site): every page to the gate at priority 1, study sites and passes
//   allowed at priority 3.
// allowSites (priority 3, pages and frames): a site with its own limit and time left inside a closed domain
//   (cooking.nytimes.com while News is closed), since its time counts against nothing else.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The whole URL is matched, so \0 hands all of it to the gate. "www.x.com" matches x.com; "x.com.evil.io"
// and "evil.io/?u=x.com" do not.
export function domainRegex(domain) {
  return "^https?://([^/?#@]*\\.)?" + escape(domain) + "\\.?([:/?#].*)?$";
}

/**
 * The addresses of one YouTube video, from its key "yt:<id>", as urlFilter patterns: watch (v first or
 * later), shorts, live and youtu.be. A regular expression covering them all is over Chrome's 2 KB limit for
 * a compiled regexFilter, and the browser then rejects every rule written with it.
 */
export function videoFilters(key) {
  const id = key.slice(3);
  return [`||youtube.com/watch?v=${id}^`, `||youtube.com/watch?*&v=${id}^`, `||youtube.com/shorts/${id}^`, `||youtube.com/live/${id}^`, `||youtu.be/${id}^`];
}

export function buildRules({ redirect = [], block = [], allowVideos = [], closeVideos = [], allowSites = [], examAll = null }, gatePage) {
  let id = 1;
  const rules = [];
  if (examAll) {
    // Exam mode, where Gatekeeper may see every site: every page goes to the gate (priority 1, under every other
    // rule), except study sites and sites with a pass (priority 3).
    rules.push({ id: id++, priority: 1, action: { type: "redirect", redirect: { regexSubstitution: gatePage + "#\\0" } },
      condition: { regexFilter: "^https?://.*", resourceTypes: ["main_frame"] } });
    if (examAll.allow.length) rules.push({ id: id++, priority: 3, action: { type: "allow" }, condition: { requestDomains: examAll.allow, resourceTypes: ["main_frame"] } });
  }
  if (allowSites.length) {
    rules.push({ id: id++, priority: 3, action: { type: "allow" }, condition: { requestDomains: allowSites, resourceTypes: ["main_frame", "sub_frame"] } });
  }
  for (const key of allowVideos) {
    for (const urlFilter of videoFilters(key)) {
      rules.push({ id: id++, priority: 3, action: { type: "allow" }, condition: { urlFilter, resourceTypes: ["main_frame"] } });
    }
  }
  for (const key of closeVideos) {
    const url = gatePage + "#https://www.youtube.com/watch?v=" + key.slice(3);
    for (const urlFilter of videoFilters(key)) {
      rules.push({ id: id++, priority: 2, action: { type: "redirect", redirect: { url } }, condition: { urlFilter, resourceTypes: ["main_frame"] } });
    }
  }
  for (const domain of redirect) {
    rules.push({
      id: id++, priority: 2,
      action: { type: "redirect", redirect: { regexSubstitution: gatePage + "#\\0" } },
      condition: { regexFilter: domainRegex(domain), resourceTypes: ["main_frame"] },
    });
  }
  if (block.length) {
    rules.push({
      id: id++, priority: 1, action: { type: "block" },
      condition: { requestDomains: block, resourceTypes: ["main_frame", "sub_frame"] },
    });
  }
  return rules;
}
