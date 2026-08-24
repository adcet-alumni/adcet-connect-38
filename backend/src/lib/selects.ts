/**
 * Shared Prisma selects for the person attached to a record — the alumnus who
 * posted a job, created an event or submitted an achievement.
 *
 * Every one of those payloads used to carry that person's email address to any
 * approved member, while the page rendered nothing but their name. An email is
 * the one field on `User` that is contact information rather than identity, so
 * it is opt-in per request and only an admin ever opts in: `person(true)` is
 * for admin surfaces (moderation queues, ledgers, exports) and the plain
 * `person()` is what a member-facing listing gets.
 *
 * Prisma reads `email: false` as "not selected", so this stays one shape rather
 * than two, and a field added here is added everywhere on purpose.
 */
export const personSelect = (includeEmail = false) =>
  ({ id: true, firstName: true, lastName: true, email: includeEmail }) as const;

/** The same thing wrapped as Prisma's `{ select }` for a relation. */
export const person = (includeEmail = false) => ({ select: personSelect(includeEmail) });
