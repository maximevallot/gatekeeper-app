// The calendar link (one-model plan, gap 8): read on the device, it gives the exam offer and the gate's deadlines.
import test from "node:test";
import assert from "node:assert/strict";
import { parseIcs, calendarUrl, icsTime } from "../extension/engine/calendar.js";
import {
  initialState, completeSetup, setHelp, setCalendar, recordCalendar, calendarDue, examOffer, dismissOffer, todaySummary, gateRequest,
  startExam, snapshot, WHATS_SENT, CONSENT,
} from "../extension/engine/engine.js";

const at = (iso) => new Date(iso).getTime();
const MON = at("2026-10-19T20:00:00-04:00");
// The folded title's continuation starts with two spaces: the first only marks the fold.
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VEVENT", "SUMMARY:15.425 Midterm", "DTSTART:20261021T123000Z", "END:VEVENT",
  "BEGIN:VEVENT", "SUMMARY:Problem set 4 due\\, 15.390", "DTSTART;VALUE=DATE:20261020", "END:VEVENT",
  "BEGIN:VEVENT", "SUMMARY:A very long title that is folded", "  across two lines", "DTSTART;TZID=America/New_York:20261023T090000", "END:VEVENT",
  "BEGIN:VEVENT", "SUMMARY:Final exam", "DTSTART:20261105T140000Z", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");
const setUp = () => setHelp({ ...completeSetup(initialState(), { kinds: { video: 0 }, goal: "Midterm" }, MON).state, installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" }, true);
const withCal = () => recordCalendar(setCalendar(setUp(), "webcal://canvas.mit.edu/feeds/calendars/user_x.ics").state, ICS, MON);

test("a calendar feed is read: titles unescaped and unfolded, all-day, UTC and local times", () => {
  const ev = parseIcs(ICS);
  assert.deepEqual(ev.map((e) => e.title), ["Problem set 4 due, 15.390", "15.425 Midterm", "A very long title that is folded across two lines", "Final exam"]);
  assert.equal(ev[1].start, at("2026-10-21T12:30:00Z"));
  assert.equal(ev[0].start, new Date(2026, 9, 20).getTime());
  assert.equal(icsTime("20261023T090000"), new Date(2026, 9, 23, 9, 0, 0).getTime());
  assert.equal(calendarUrl("webcal://canvas.mit.edu/feed.ics"), "https://canvas.mit.edu/feed.ics");
  assert.equal(calendarUrl("javascript:alert(1)"), null);
  assert.equal(setCalendar(setUp(), "not a link").refused, "bad_url");
});

test("an exam in the next 48 hours is offered once, on Today and to the Mac; it never starts by itself", () => {
  const s = withCal();
  const o = examOffer(s, MON);
  assert.deepEqual(o, { title: "15.425 Midterm", start: at("2026-10-21T12:30:00Z") });
  assert.deepEqual(todaySummary(s, MON).offer, o);
  assert.deepEqual(snapshot(s, MON, {}).offer, o);
  assert.equal(s.rules.exam, null);
  assert.equal(examOffer(dismissOffer(s, o), MON), null, "Not now: not shown again for that exam");
  assert.equal(examOffer(startExam(s, { until: o.start, goal: o.title }, MON).state, MON), null, "already in exam mode");
  assert.equal(examOffer(s, at("2026-10-22T12:00:00-04:00")), null, "after the midterm, nothing else is an exam within 48 hours");
});

test("the gate is sent the next deadlines from the calendar", () => {
  const s = { ...withCal(), usage: { ...withCal().usage, seconds: {} } };
  const p = gateRequest(s, { url: "https://www.youtube.com/", message: "lecture", now: MON }).payload;
  assert.deepEqual(p.deadlines.map((d) => d.title), ["Problem set 4 due, 15.390", "15.425 Midterm", "A very long title that is folded across two lines"]);
  assert.equal(p.deadlines[1].due, "2026-10-21");
});

test("the calendar is read again once a day; Claude help's list says what goes to the gate, and was asked again", () => {
  assert.ok(calendarDue(setCalendar(setUp(), "https://x.example/c.ics").state, MON));
  assert.ok(!calendarDue(withCal(), MON + 3600e3));
  assert.ok(calendarDue(withCal(), MON + 25 * 3600e3));
  assert.ok(/calendar/.test(WHATS_SENT.find((w) => w.what === "The gate").sent));
  assert.ok(/exam mode/.test(WHATS_SENT.find((w) => /talking/.test(w.what)).sent));
  assert.equal(CONSENT.help, 3);
});

test("Maxime's re-test: a Google share link is refused with Google's steps; a page that isn't a feed is said, not read as empty", async () => {
  const { calendarProblem, isIcs, CALENDAR_HELP } = await import("../extension/engine/calendar.js");
  const { calendarStatus, chatRequest } = await import("../extension/engine/engine.js");
  for (const url of ["https://calendar.google.com/calendar/u/0?cid=bWF4aW1l", "https://calendar.google.com/calendar/embed?src=x%40gmail.com", "https://calendar.google.com/calendar/r"]) {
    assert.equal(setCalendar(setUp(), url).refused, "google_share", url);
  }
  assert.equal(calendarProblem("https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics"), null, "the secret iCal address is a feed");
  assert.match(CALENDAR_HELP.google_share, /Integrate calendar › "Secret address in iCal format"/);
  assert.ok(isIcs(ICS) && !isIcs("<html>Sign in</html>"));
  const s = recordCalendar(setCalendar(setUp(), "https://example.edu/feed.ics").state, "<html>Sign in</html>", MON);
  assert.equal(s.calendar.error, "not_ical");
  assert.deepEqual(calendarStatus(s), { status: "failed", readAt: null }, "never read fine");
  // The chat's calendar state: only that, no link, no titles; and not sent until the privacy policy lists it.
  const ok = { ...withCal(), installId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" };
  const payload = chatRequest(setHelp(ok, true), { message: "are you connected to my calendar now?", now: MON }).payload;
  const { SEND_CALENDAR_STATUS } = await import("../extension/engine/engine.js");
  assert.equal("calendar" in payload, SEND_CALENDAR_STATUS);
  assert.deepEqual(calendarStatus(ok), { status: "connected", readAt: "2026-10-19T20:00:00-04:00" });
  const failedLater = recordCalendar(ok, "<html>Sign in</html>", MON + 86400e3);
  assert.deepEqual(calendarStatus(failedLater), { status: "failed", readAt: "2026-10-19T20:00:00-04:00" }, "readAt stays the last good read");
  assert.ok(!JSON.stringify(payload).includes("canvas.mit.edu") && !JSON.stringify(payload).includes("Midterm"));
  assert.deepEqual(calendarStatus(setUp()), { status: "none", readAt: null });
});
