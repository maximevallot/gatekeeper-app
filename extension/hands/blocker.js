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

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The whole URL is matched, so \0 hands all of it to the gate. "www.x.com" matches x.com; "x.com.evil.io"
// and "evil.io/?u=x.com" do not.
export function domainRegex(domain) {
  return "^https?://([^/?#@]*\\.)?" + escape(domain) + "\\.?([:/?#].*)?$";
}

/** The whole address of one YouTube video page, watch, shorts or youtu.be, from its key "yt:<id>". */
export function videoRegex(key) {
  const id = escape(key.slice(3));
  return "^https?://(([^/?#@]*\\.)?youtube\\.com/(watch\\?([^#]*&)?v=" + id + "|(shorts|live)/" + id + ")|(www\\.)?youtu\\.be/" + id + ")([&?#/].*)?$";
}

export function buildRules({ redirect = [], block = [], allowVideos = [], closeVideos = [] }, gatePage) {
  let id = 1;
  const rules = [];
  for (const key of allowVideos) {
    rules.push({ id: id++, priority: 3, action: { type: "allow" }, condition: { regexFilter: videoRegex(key), resourceTypes: ["main_frame"] } });
  }
  for (const key of closeVideos) {
    rules.push({
      id: id++, priority: 2,
      action: { type: "redirect", redirect: { regexSubstitution: gatePage + "#\\0" } },
      condition: { regexFilter: videoRegex(key), resourceTypes: ["main_frame"] },
    });
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
