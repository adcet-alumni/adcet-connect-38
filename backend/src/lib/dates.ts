/**
 * Date formatting for anything that leaves the server (emails, receipts).
 *
 * Columns like `CollaborationRequest.driveDate` or `Achievement.occurredOn`
 * hold a *calendar day*, not an instant: the browser sends `2026-09-15` from a
 * date input and `z.coerce.date()` stores it as midnight UTC. Formatting that
 * with the process's own zone renders the previous day anywhere west of UTC —
 * the decision email would tell an alumnus a date they never picked. So every
 * day-only value is rendered in UTC, which is the zone it was written in.
 */
const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
};

/** `15 Sep 2026` — stable regardless of the server's time zone. */
export const formatDay = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString("en-IN", DAY_FORMAT) : "";
