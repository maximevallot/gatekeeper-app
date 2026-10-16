// Turns the engine's closed domains into declarativeNetRequest rules: a closed site is redirected to the
// gate page before it loads, with its own URL after the "#", so nothing of it ever renders. Adapted from
// the personal prototype (~/gatekeeper, commit f2984cc), with the gate inside the extension instead of on
// a local server.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The whole URL is matched, so \0 hands all of it to the gate. "www.x.com" matches x.com; "x.com.evil.io"
// and "evil.io/?u=x.com" do not.
export function domainRegex(domain) {
  return "^https?://([^/?#@]*\\.)?" + escape(domain) + "([:/?#].*)?$";
}

export function buildRules(domains, gatePage) {
  return domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution: gatePage + "#\\0" } },
    condition: { regexFilter: domainRegex(domain), resourceTypes: ["main_frame"] },
  }));
}
