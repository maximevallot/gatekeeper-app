// The messages the pages and the background worker exchange. Bump PROTOCOL whenever a page starts sending
// a message an older worker would not understand. A browser can keep an old worker running beside new
// pages (an unpacked extension that was not reloaded), and then the pages say so instead of failing quietly.
export const PROTOCOL = 3;
