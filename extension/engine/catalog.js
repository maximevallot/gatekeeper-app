// The built-in catalog: common sites sorted into kinds. A rule names a kind ("games: 15 min a day"),
// never a list of domains, so a site the user has never set up still counts once it is sorted here.
// In milestone 1 a site not in this list, and not added by the user, is allowed; in milestone 2 Claude
// sorts it.
//
// Part of the engine: no browser APIs, so it can move to a server unchanged.

export const KINDS = {
  social: {
    examples: "Instagram, TikTok, Reddit, X",
    label: "Social media",
    domains: [
      "instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com", "reddit.com", "snapchat.com",
      "threads.net", "bsky.app", "pinterest.com", "tumblr.com", "linkedin.com", "vk.com", "weibo.com",
    ],
  },
  video: {
    examples: "YouTube, Netflix, Twitch",
    label: "Video",
    domains: [
      "youtube.com", "youtu.be", "youtube-nocookie.com", "netflix.com", "twitch.tv", "primevideo.com", "disneyplus.com", "hulu.com",
      "max.com", "vimeo.com", "dailymotion.com", "crunchyroll.com", "bilibili.com", "kick.com",
    ],
  },
  games: {
    examples: "OpenFront, agar.io, chess.com",
    label: "Games",
    domains: [
      "openfront.io", "agar.io", "slither.io", "diep.io", "krunker.io", "chess.com", "lichess.org", "poki.com",
      "crazygames.com", "miniclip.com", "coolmathgames.com", "geoguessr.com", "roblox.com", "itch.io",
      "armorgames.com", "kongregate.com", "addictinggames.com", "neal.fun", "wordle.global", "skribbl.io",
    ],
  },
  news: {
    examples: "NYT, CNN, Hacker News",
    label: "News",
    domains: [
      "cnn.com", "nytimes.com", "bbc.com", "bbc.co.uk", "theguardian.com", "foxnews.com", "washingtonpost.com",
      "wsj.com", "ft.com", "bloomberg.com", "reuters.com", "apnews.com", "nbcnews.com", "politico.com",
      "news.ycombinator.com", "news.google.com", "lemonde.fr", "spiegel.de", "huffpost.com", "axios.com",
    ],
  },
  shopping: {
    examples: "Amazon, Etsy, Shein",
    label: "Shopping",
    domains: [
      "amazon.com", "ebay.com", "etsy.com", "aliexpress.com", "temu.com", "shein.com", "walmart.com",
      "target.com", "bestbuy.com", "zara.com", "asos.com", "hm.com", "uniqlo.com", "wayfair.com", "zalando.com",
    ],
  },
};

export const KIND_ORDER = ["social", "video", "games", "news", "shopping"];

export function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

// "www.youtube.com" is youtube.com; "youtube.com.evil.io" is not.
export function matches(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

export function catalogKind(host) {
  if (!host) return null;
  let best = null;
  for (const kind of KIND_ORDER) {
    for (const d of KINDS[kind].domains) {
      // The longest match wins, so news.google.com is news even if google.com were ever listed elsewhere.
      if (matches(host, d) && (!best || d.length > best.domain.length)) best = { kind, domain: d };
    }
  }
  return best ? best.kind : null;
}

// Names under which anyone can register a site: never a site of their own, since a rule on "co.uk" or
// "github.io" would cover thousands of sites (QA round 2, C4). Not the whole public suffix list: the ones in use.
export const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au", "co.nz", "co.jp", "ne.jp",
  "or.jp", "co.kr", "com.br", "com.mx", "com.ar", "co.in", "co.za", "com.cn", "com.tw", "com.hk", "com.sg", "com.tr",
  "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "wordpress.com", "substack.com",
]);

/** A domain a rule may name: a host with a dot, not a public suffix. "www." is dropped. */
export function ruleDomain(raw) {
  const d = String(raw || "").trim().toLowerCase();
  const host = hostOf(d.includes("://") ? d : "https://" + d + "/");
  if (!host || !host.includes(".") || PUBLIC_SUFFIXES.has(host)) return null;
  return host.replace(/^www\./, "");
}
