/**
 * `driveDate`, `startDate`, `occurredOn` and friends hold a calendar day, not
 * an instant: a date input sends `2026-09-15` and `z.coerce.date()` stores
 * midnight UTC. Rendering that with the process's own zone shows the previous
 * day anywhere west of UTC, so the collaboration decision email would report a
 * date the alumnus never picked.
 */
import { formatDay } from "../../lib/dates.js";

const withTz = (tz: string, fn: () => void) => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    process.env.TZ = prev;
  }
};

const day = new Date("2026-09-15T00:00:00.000Z");

describe("formatDay", () => {
  it("renders the stored calendar day", () => {
    // Month spelling comes from ICU ("Sep"/"Sept" by version); the day and the
    // year are what this guards.
    expect(formatDay(day)).toMatch(/^15 \w+ 2026$/);
  });

  it("does not drift with the server's time zone", () => {
    // Honolulu is UTC-10 — midnight UTC is 2pm on the 14th there — and
    // Kiritimati is UTC+14, a day ahead.
    withTz("Pacific/Honolulu", () => expect(formatDay(day)).toMatch(/^15 /));
    withTz("Pacific/Kiritimati", () => expect(formatDay(day)).toMatch(/^15 /));
  });

  it("renders an absent date as an empty string", () => {
    expect(formatDay(null)).toBe("");
    expect(formatDay(undefined)).toBe("");
  });
});
