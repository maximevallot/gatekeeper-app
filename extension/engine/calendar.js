// A calendar the user pastes once (Canvas's calendar feed, Google Calendar's secret address): read on this
// computer, never sent anywhere. Its events give the exam offer ("Midterm, Wed 8:30. Start exam mode until
// then?") and the gate's deadlines. Part of the engine: no browser APIs.

/** webcal:// and https:// links to a calendar feed; anything else is refused. */
export function calendarUrl(raw) {
  const s = String(raw || "").trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const u = new URL(s);
    // https only; plain http only on this computer (a local test feed), never across the network.
    const local = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
    return u.protocol === "https:" || local ? u.href : null;
  } catch {
    return null;
  }
}

function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeText(v) {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim();
}

/** DTSTART values: 20261022 (a day), 20261022T083000Z (UTC), 20261022T083000 (local, or with a TZID). */
export function icsTime(value, params = "") {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z?))?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, z] = m;
  if (h === undefined || /VALUE=DATE(?!-)/i.test(params)) return new Date(+y, +mo - 1, +d, 0, 0, 0).getTime();
  return z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)) : new Date(+y, +mo - 1, +d, +h, +mi, +(se || 0)).getTime();
}

/** The events of a calendar feed: { title, start, allDay }, sorted by start. */
export function parseIcs(text) {
  const out = [];
  let ev = null;
  for (const line of unfold(text).split("\n")) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT") {
      if (ev && ev.title && ev.start) out.push(ev);
      ev = null;
    } else if (ev) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(";");
      const value = line.slice(i + 1);
      if (name === "SUMMARY") ev.title = unescapeText(value).slice(0, 200);
      else if (name === "DTSTART") {
        ev.start = icsTime(value, params.join(";"));
        ev.allDay = !/T/.test(value);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Titles that mean an exam. */
export const EXAM_WORDS = /\b(exam|midterm|mid-term|final|quiz|test|partiel|examen)\b/i;

/**
 * A link that can't be a feed, said plainly (Maxime's re-test, 2026-10-18): Google Calendar's share and embed links
 * are web pages one signs in to, not the iCalendar feed Gatekeeper reads.
 */
export function calendarProblem(raw) {
  let u;
  try { u = new URL(String(raw || "").trim().replace(/^webcals?:\/\//i, "https://")); } catch { return null; } // calendarUrl refuses it
  if (u.hostname === "calendar.google.com" && !/\.ics$/i.test(u.pathname) && !/\/ical\//.test(u.pathname)) return "google_share";
  return null;
}

/** Whether a read answer is an iCalendar feed. */
export function isIcs(text) {
  return /BEGIN:VCALENDAR/.test(String(text || "").slice(0, 5000));
}

/** What to say when a calendar link isn't a feed: where each service gives the right one. */
export const CALENDAR_HELP = {
  google_share: "That's Google Calendar's share link, a page you sign in to. Gatekeeper needs the calendar's feed: in Google Calendar, open Settings, pick the calendar, then Integrate calendar › \"Secret address in iCal format\" (it ends in .ics).",
  not_ical: "That link opens a web page, not a calendar feed. In Canvas: Calendar › Calendar Feed. In Google Calendar: Settings › the calendar › Integrate calendar › \"Secret address in iCal format\" (it ends in .ics).",
  sign_in: "That link asks to sign in, so it isn't a feed. In Canvas: Calendar › Calendar Feed. In Google Calendar: Settings › the calendar › Integrate calendar › \"Secret address in iCal format\".",
  bad_url: "That isn't a calendar feed link. Paste the feed's address (it usually ends in .ics).",
};
