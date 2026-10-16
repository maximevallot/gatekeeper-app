// Turns the engine's enforcement into declarativeNetRequest rules. Adapted from the personal prototype
// (~/gatekeeper, commit f2984cc), with the gate inside the extension instead of on a local server.
//
// redirect (priority 2, top-level pages): a closed site goes to the gate page before it loads, with its own
//   URL after the "#", so nothing of it renders. A redirect fires only where the extension has access to
//   the site.
// block (priority 1, top-level pages and frames): the same sites, for embedded players, and for a site
//   whose access was withheld, where the redirect cannot fire; plus watched sites Gatekeeper cannot see.
//   A block needs no access to the site, so taking access away does not open it.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The whole URL is matched, so \0 hands all of it to the gate. "www.x.com" matches x.com; "x.com.evil.io"
// and "evil.io/?u=x.com" do not.
export function domainRegex(domain) {
  return "^https?://([^/?#@]*\\.)?" + escape(domain) + "\\.?([:/?#].*)?$";
}

export function buildRules({ redirect = [], block = [] }, gatePage) {
  let id = 1;
  const rules = [];
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
