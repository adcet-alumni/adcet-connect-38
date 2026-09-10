import { prisma } from "../../lib/prisma.js";
import {
  COLLABORATION_TYPES,
  type CollaborationTypeName,
} from "../../config/constants.js";
import { Prisma, DegreeType } from "@prisma/client";
import { paginationMeta } from "../../lib/pagination.js";
import { sendBulkEmails } from "../../lib/mailer.js";
import { wrapHtmlEmail } from "../../lib/email-templates.js";
import { getStorage } from "../../storage/index.js";

/**
 * Aggregate counts feeding the public analytics dashboard.
 *
 * "Jobs posted" and "events held" are running totals, so they have to include
 * what retention has since deleted — otherwise the college's numbers would
 * shrink every night as postings aged out. `ArchivedContent` is where those
 * rows' dimensions survive; see `jobs/contentRetention.ts`.
 */
export const overview = async () => {
  const [users, alumni, events, jobs, achievements, donations, archived] = await Promise.all([
    prisma.user.count({ where: { status: "APPROVED" } }),
    prisma.userRole.count({ where: { role: "ALUMNI", user: { status: "APPROVED" } } }),
    prisma.event.count({ where: { status: "APPROVED" } }),
    prisma.job.count({ where: { status: "APPROVED" } }),
    prisma.achievement.count({ where: { status: "APPROVED" } }),
    prisma.donation.aggregate({ where: { status: "RECEIVED" }, _sum: { amount: true }, _count: true }),
    prisma.archivedContent.groupBy({
      by: ["kind"],
      where: { status: "APPROVED" },
      _count: { _all: true },
    }),
  ]);
  const archivedOf = (kind: "JOB" | "EVENT") =>
    archived.find((a) => a.kind === kind)?._count._all ?? 0;

  return {
    totalUsers: users,
    totalAlumni: alumni,
    totalEvents: events + archivedOf("EVENT"),
    totalJobs: jobs + archivedOf("JOB"),
    totalAchievements: achievements,
    totalDonationsAmount: donations._sum.amount ?? 0,
    totalDonationsCount: donations._count,
  };
};

/** Alumni count grouped by graduation year — line chart on dashboard. */
export const alumniByYear = async () => {
  const grouped = await prisma.profile.groupBy({
    by: ["graduationYear"],
    where: { graduationYear: { not: null }, user: { status: "APPROVED" } },
    _count: { _all: true },
  });
  return grouped
    .filter((g) => g.graduationYear)
    .map((g) => ({ year: g.graduationYear, count: g._count._all }))
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
};

export const departmentBreakdown = async () => {
  const grouped = await prisma.profile.groupBy({
    by: ["department"],
    where: { department: { not: null }, user: { status: "APPROVED" } },
    _count: { _all: true },
  });
  return grouped.map((g) => ({ department: g.department, count: g._count._all }));
};

/** Admin-only — unfiltered moderation pipeline counters. */
export const adminOverview = async () => {
  const [pendingUsers, pendingEvents, pendingJobs, pendingAchievements, pendingCollaboration] =
    await Promise.all([
      prisma.user.count({ where: { status: "PENDING" } }),
      prisma.event.count({ where: { status: "PENDING" } }),
      prisma.job.count({ where: { status: "PENDING" } }),
      prisma.achievement.count({ where: { status: "PENDING" } }),
      // Grouped so the admin sidebar can badge each collaboration type
      // separately without one query per type.
      prisma.collaborationRequest.groupBy({
        by: ["type"],
        where: { status: "PENDING" },
        _count: { _all: true },
      }),
    ]);
  // Keyed by collaboration type so the admin sidebar can badge each kind, and
  // a kind added to `COLLABORATION_TYPES` shows up here without a new field.
  const pendingCollaborationByType = Object.fromEntries(
    COLLABORATION_TYPES.map((t) => [
      t,
      pendingCollaboration.find((g) => g.type === t)?._count._all ?? 0,
    ]),
  ) as Record<CollaborationTypeName, number>;

  return {
    pendingUsers,
    pendingEvents,
    pendingJobs,
    pendingAchievements,
    pendingCollaboration: pendingCollaborationByType,
    // Kept for older clients that read the two flat counters by name.
    pendingPlacements: pendingCollaborationByType.PLACEMENT,
    pendingWorkshops: pendingCollaborationByType.WORKSHOP,
  };
};

/** Admin-only — filterable alumni list for analytics. */
export type AlumniFilter = {
  q?: string;
  branch?: string;
  department?: string;
  /** Chapter id, or the literal "none" for alumni who haven't joined one. */
  chapterId?: string;
  graduationYear?: number;
  degree?: DegreeType;
  city?: string;
  country?: string;
  location?: string;
  currentCompany?: string;
  company?: string;
  currentRole?: string;
  skill?: string;
};

/**
 * Build the Prisma where-clause for approved-alumni filtering. Shared by the
 * analytics table and the bulk-email recipient resolver so both target the
 * exact same set.
 */
export const buildAlumniWhere = (q: AlumniFilter): Prisma.ProfileWhereInput => {
  const company = q.company ?? q.currentCompany;
  const branch = q.branch ?? q.department;
  const location = q.location;
  const and: Prisma.ProfileWhereInput[] = [];
  if (q.q) {
    and.push({
      OR: [
        { user: { firstName: { contains: q.q, mode: "insensitive" } } },
        { user: { lastName: { contains: q.q, mode: "insensitive" } } },
        { user: { email: { contains: q.q, mode: "insensitive" } } },
        { currentCompany: { contains: q.q, mode: "insensitive" } },
        { currentRole: { contains: q.q, mode: "insensitive" } },
        { department: { contains: q.q, mode: "insensitive" } },
        { city: { contains: q.q, mode: "insensitive" } },
      ],
    });
  }
  if (company) {
    and.push({
      OR: [
        { currentCompany: { contains: company, mode: "insensitive" } },
        { experiences: { some: { company: { contains: company, mode: "insensitive" } } } },
      ],
    });
  }
  if (location) {
    and.push({
      OR: [
        { city: { contains: location, mode: "insensitive" } },
        { country: { contains: location, mode: "insensitive" } },
        { experiences: { some: { location: { contains: location, mode: "insensitive" } } } },
      ],
    });
  }
  return {
    user: { status: "APPROVED", roles: { some: { role: "ALUMNI" } } },
    ...(and.length && { AND: and }),
    ...(branch && { department: { contains: branch, mode: "insensitive" } }),
    ...(q.chapterId && { chapterId: q.chapterId === "none" ? null : q.chapterId }),
    ...(q.graduationYear && { graduationYear: q.graduationYear }),
    ...(q.degree && { degree: q.degree }),
    ...(q.city && { city: { contains: q.city, mode: "insensitive" } }),
    ...(q.country && { country: { contains: q.country, mode: "insensitive" } }),
    ...(q.currentRole && { currentRole: { contains: q.currentRole, mode: "insensitive" } }),
    ...(q.skill && {
      skills: { some: { skill: { name: { contains: q.skill, mode: "insensitive" } } } },
    }),
  };
};

export const alumniList = async (q: AlumniFilter & { page?: number; pageSize?: number }) => {
  const where = buildAlumniWhere(q);
  const page = q.page ?? 1;
  const pageSize = Math.min(q.pageSize ?? 100, 500);
  const [items, total] = await Promise.all([
    prisma.profile.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        userId: true,
        department: true,
        graduationYear: true,
        city: true,
        country: true,
        degree: true,
        admissionYear: true,
        currentCompany: true,
        currentRole: true,
        phone: true,
        linkedinUrl: true,
        skills: { select: { skill: { select: { name: true } } } },
        user: { select: { firstName: true, lastName: true, email: true } },
        chapter: { select: { id: true, name: true, slug: true } },
      },
      orderBy: [{ graduationYear: "desc" }, { user: { lastName: "asc" } }],
    }),
    prisma.profile.count({ where }),
  ]);
  return {
    items: items.map((item) => ({
      ...item,
      skills: item.skills.map((s) => s.skill.name),
    })),
    pagination: paginationMeta(total, { page, pageSize }),
  };
};

export const alumniFacets = async () => {
  const baseWhere: Prisma.ProfileWhereInput = {
    user: { status: "APPROVED", roles: { some: { role: "ALUMNI" } } },
  };
  const [departments, companies, cities, years, degrees] = await Promise.all([
    prisma.profile.groupBy({
      by: ["department"],
      where: { ...baseWhere, department: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { department: "desc" } },
      take: 20,
    }),
    prisma.profile.groupBy({
      by: ["currentCompany"],
      where: { ...baseWhere, currentCompany: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { currentCompany: "desc" } },
      take: 20,
    }),
    prisma.profile.groupBy({
      by: ["city"],
      where: { ...baseWhere, city: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { city: "desc" } },
      take: 20,
    }),
    prisma.profile.groupBy({
      by: ["graduationYear"],
      where: { ...baseWhere, graduationYear: { not: null } },
      _count: { _all: true },
      orderBy: { graduationYear: "desc" },
      take: 30,
    }),
    prisma.profile.groupBy({
      by: ["degree"],
      where: { ...baseWhere, degree: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Chapters are listed in full (not just the ones with members) so the admin
  // filter offers every chapter, including brand-new empty ones.
  const chapterRows = await prisma.chapter.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, slug: true, _count: { select: { members: { where: baseWhere } } } },
  });

  return {
    departments: departments.map((d) => ({ value: d.department, count: d._count._all })),
    companies: companies.map((c) => ({ value: c.currentCompany, count: c._count._all })),
    cities: cities.map((c) => ({ value: c.city, count: c._count._all })),
    years: years.map((y) => ({ value: y.graduationYear, count: y._count._all })),
    degrees: degrees.map((d) => ({ value: d.degree, count: d._count._all })),
    chapters: chapterRows.map((c) => ({
      value: c.id,
      label: c.name,
      slug: c.slug,
      count: c._count.members,
    })),
  };
};

/* -------------------------------------------------------------------------- */
/*  Admin insights dashboard — KPIs, monthly trends, and distributions.       */
/*  Filterable by date range + department. Admins are excluded everywhere.    */
/* -------------------------------------------------------------------------- */

const NOT_ADMIN = { roles: { none: { role: "ADMIN" as const } } };

/*
 * Everything below aggregates in Postgres rather than in Node.
 *
 * This endpoint used to `findMany` every user, event, job, donation and
 * achievement with no `take` — the default page load, with no date filter,
 * fetched the whole table — and then bucketed them into months in JavaScript.
 * At 50k users and 200k donations that is hundreds of thousands of rows over
 * the wire per dashboard open, to produce a few dozen numbers. `GROUP BY` does
 * it for free and the result set is months × statuses: tens of rows.
 *
 * Two things the SQL has to keep faithful to the old JavaScript, both pinned
 * by tests in `analytics.insights.test.ts` which run against a real database:
 *
 * 1. **Month keys are UTC.** The old code did
 *    `new Date(d).toISOString().slice(0, 7)`. Prisma maps `DateTime` to
 *    `timestamp(3)` *without* time zone and stores UTC instants, so
 *    `date_trunc('month', col)` buckets on the same instant — but only as long
 *    as nothing casts to `timestamptz` on the way, which would re-interpret it
 *    in the server's zone and move rows near a month boundary.
 * 2. **Donations bucket by `paidAt ?? createdAt` while being *filtered* by
 *    `createdAt`.** A gift pledged in March and settled in April counts toward
 *    April's revenue but belongs to a March-to-March date filter.
 */

/** One `GROUP BY month, status` row. Every trend query returns this shape. */
interface MonthStatusRow {
  month: string;
  status: string;
  count: number;
}

/** `WHERE`-clause fragments, composed per entity. `Prisma.sql` parameterises. */
const createdBetween = (column: Prisma.Sql, from?: Date, to?: Date): Prisma.Sql =>
  Prisma.sql`
    ${from ? Prisma.sql`AND ${column} >= ${from}` : Prisma.empty}
    ${to ? Prisma.sql`AND ${column} <= ${to}` : Prisma.empty}`;

/** `YYYY-MM`, in UTC, matching what `toISOString().slice(0, 7)` produced. */
const monthOf = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`to_char(date_trunc('month', ${column}), 'YYYY-MM')`;

/** Collapse `(month, status)` rows to a sorted monthly series. */
const trendFrom = (rows: MonthStatusRow[]): { month: string; count: number }[] => {
  const byMonth = new Map<string, number>();
  for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.count);
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, count]) => ({ month, count }));
};

/** Collapse `(month, status)` rows to the status distribution the charts draw. */
const statusFrom = (rows: { status: string; count: number }[]) => {
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + r.count);
  return [...byStatus.entries()].map(([label, value]) => ({ label, value }));
};

const total = (rows: { count: number }[]) => rows.reduce((sum, r) => sum + r.count, 0);
const totalWhere = (rows: MonthStatusRow[], status: string) =>
  total(rows.filter((r) => r.status === status));

export const adminInsights = async (f: { from?: Date; to?: Date; department?: string }) => {
  const { from, to, department: dept } = f;
  const alumniWhere: Prisma.ProfileWhereInput = {
    user: { status: "APPROVED", ...NOT_ADMIN },
    ...(dept && { department: dept }),
  };

  /*
   * A department narrows an event or a job through `departments` — the
   * `String[]` column that replaced the single nullable `department` in
   * migration `20260803150000_multi_department_targeting`. `= ANY(...)` is the
   * SQL behind Prisma's `has`, the same filter the events and jobs read paths
   * apply, so "aimed at X" means the same thing on the dashboard as it does in
   * the listings, and postings open to everyone (an empty array) are excluded
   * from a department-specific view rather than counted into all of them.
   */
  const eventWhere: Prisma.EventWhereInput = {
    ...(from || to ? { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
    ...(dept && { departments: { has: dept } }),
  };
  /**
   * The same filter against `ArchivedContent`, whose `createdAt` and
   * `departments` are copied verbatim from the row it replaced — so a date
   * range or a department selects the same postings on either side of a purge.
   */
  const archivedWhere: Prisma.ArchivedContentWhereInput = {
    ...(from || to ? { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
    ...(dept && { departments: { has: dept } }),
  };
  const deptInArray = (column: Prisma.Sql) =>
    dept ? Prisma.sql`AND ${dept} = ANY(${column})` : Prisma.empty;

  const [userRows, eventRows, jobRows, donationRows, achievementRows] = await Promise.all([
    /*
     * `NOT EXISTS` is Prisma's `roles: { none: { role: "ADMIN" } }`, and the
     * `EXISTS` on Profile is `profile: { department }` — a scalar column on the
     * profile, unlike the arrays on Event and Job above.
     */
    prisma.$queryRaw<MonthStatusRow[]>`
      SELECT ${monthOf(Prisma.sql`u."createdAt"`)} AS month,
             u.status::text AS status,
             count(*)::int AS count
      FROM "User" u
      WHERE NOT EXISTS (
              SELECT 1 FROM "UserRole" r WHERE r."userId" = u.id AND r.role = 'ADMIN')
        ${createdBetween(Prisma.sql`u."createdAt"`, from, to)}
        ${dept
          ? Prisma.sql`AND EXISTS (
              SELECT 1 FROM "Profile" p WHERE p."userId" = u.id AND p.department = ${dept})`
          : Prisma.empty}
      GROUP BY 1, 2`,

    /*
     * Live rows plus the ones retention has deleted.
     *
     * A job disappears from the platform after 45 days and an event six months
     * after it ran, but the month it was posted in must not lose it — a chart
     * that quietly shrank as content aged out would be worse than no chart.
     * `ArchivedContent` keeps each purged row's month, status and departments
     * verbatim, so the union is over identical shapes and the outer `sum`
     * folds a month that has rows on both sides.
     */
    prisma.$queryRaw<MonthStatusRow[]>`
      SELECT month, status, sum(count)::int AS count FROM (
        SELECT ${monthOf(Prisma.sql`e."createdAt"`)} AS month,
               e.status::text AS status,
               count(*)::int AS count
        FROM "Event" e
        WHERE TRUE
          ${createdBetween(Prisma.sql`e."createdAt"`, from, to)}
          ${deptInArray(Prisma.sql`e.departments`)}
        GROUP BY 1, 2
        UNION ALL
        SELECT ${monthOf(Prisma.sql`a."createdAt"`)} AS month,
               a.status::text AS status,
               count(*)::int AS count
        FROM "ArchivedContent" a
        WHERE a.kind = 'EVENT'
          ${createdBetween(Prisma.sql`a."createdAt"`, from, to)}
          ${deptInArray(Prisma.sql`a.departments`)}
        GROUP BY 1, 2
      ) t GROUP BY 1, 2`,

    // `isClosed` rides along so "open jobs" is a filter over these rows rather
    // than a sixth query. An archived job keeps the flag it was purged with.
    prisma.$queryRaw<(MonthStatusRow & { isClosed: boolean })[]>`
      SELECT month, status, "isClosed", sum(count)::int AS count FROM (
        SELECT ${monthOf(Prisma.sql`j."createdAt"`)} AS month,
               j.status::text AS status,
               j."isClosed" AS "isClosed",
               count(*)::int AS count
        FROM "Job" j
        WHERE TRUE
          ${createdBetween(Prisma.sql`j."createdAt"`, from, to)}
          ${deptInArray(Prisma.sql`j.departments`)}
        GROUP BY 1, 2, 3
        UNION ALL
        SELECT ${monthOf(Prisma.sql`a."createdAt"`)} AS month,
               a.status::text AS status,
               coalesce(a."isClosed", true) AS "isClosed",
               count(*)::int AS count
        FROM "ArchivedContent" a
        WHERE a.kind = 'JOB'
          ${createdBetween(Prisma.sql`a."createdAt"`, from, to)}
          ${deptInArray(Prisma.sql`a.departments`)}
        GROUP BY 1, 2, 3
      ) t GROUP BY 1, 2, 3`,

    // Bucketed by settlement date, filtered by creation date — see the note at
    // the top. `sum` over `int` returns `bigint`, which does not survive
    // `JSON.stringify`, hence the cast.
    prisma.$queryRaw<(MonthStatusRow & { amount: number })[]>`
      SELECT ${monthOf(Prisma.sql`coalesce(d."paidAt", d."createdAt")`)} AS month,
             d.status::text AS status,
             count(*)::int AS count,
             coalesce(sum(d.amount), 0)::int AS amount
      FROM "Donation" d
      WHERE TRUE
        ${createdBetween(Prisma.sql`d."createdAt"`, from, to)}
      GROUP BY 1, 2`,

    prisma.$queryRaw<MonthStatusRow[]>`
      SELECT ${monthOf(Prisma.sql`a."createdAt"`)} AS month,
             a.status::text AS status,
             count(*)::int AS count
      FROM "Achievement" a
      WHERE TRUE
        ${createdBetween(Prisma.sql`a."createdAt"`, from, to)}
      GROUP BY 1, 2`,
  ]);

  const [totalAlumni, liveRsvps, archivedRsvps, byDepartment, byYear, topCompanies, topCities] =
    await Promise.all([
      prisma.profile.count({ where: alumniWhere }),
      /*
       * One `COUNT(*)` over the RSVPs of the matching events. This used to be a
       * `_count: { select: { rsvps: true } }` on every event row — a correlated
       * subquery per event — summed in JavaScript, purely to produce this
       * single number.
       */
      prisma.eventRsvp.count({ where: { event: eventWhere } }),
      /*
       * The RSVPs of events retention has deleted. Their rows cascaded away
       * with the event, so the count was frozen onto the archive row at purge
       * time — this reads that, and the two are added below.
       */
      prisma.archivedContent.aggregate({
        where: { kind: "EVENT", ...archivedWhere },
        _sum: { rsvpCount: true },
      }),
      prisma.profile.groupBy({
        by: ["department"],
        where: { user: { status: "APPROVED", ...NOT_ADMIN }, department: { not: null } },
        _count: { _all: true },
      }),
      prisma.profile.groupBy({
        by: ["graduationYear"],
        where: { ...alumniWhere, graduationYear: { not: null } },
        _count: { _all: true },
        orderBy: { graduationYear: "asc" },
      }),
      prisma.profile.groupBy({
        by: ["currentCompany"],
        where: { ...alumniWhere, currentCompany: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { currentCompany: "desc" } },
        take: 10,
      }),
      prisma.profile.groupBy({
        by: ["city"],
        where: { ...alumniWhere, city: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { city: "desc" } },
        take: 10,
      }),
    ]);

  const received = donationRows.filter((d) => d.status === "RECEIVED");
  const donationTrend = new Map<string, { count: number; amount: number }>();
  for (const d of received) {
    const cur = donationTrend.get(d.month) ?? { count: 0, amount: 0 };
    cur.count += d.count;
    cur.amount += d.amount;
    donationTrend.set(d.month, cur);
  }

  return {
    kpis: {
      totalAlumni,
      newRegistrations: total(userRows),
      newUsersApproved: totalWhere(userRows, "APPROVED"),
      events: total(eventRows),
      totalRsvps: liveRsvps + (archivedRsvps._sum.rsvpCount ?? 0),
      jobs: total(jobRows),
      openJobs: total(jobRows.filter((j) => !j.isClosed)),
      achievements: total(achievementRows),
      donationsReceived: total(received),
      donationAmount: received.reduce((sum, d) => sum + d.amount, 0),
    },
    trends: {
      registrations: trendFrom(userRows),
      events: trendFrom(eventRows),
      jobs: trendFrom(jobRows),
      achievements: trendFrom(achievementRows),
      donations: [...donationTrend.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, v]) => ({ month, count: v.count, amount: v.amount })),
    },
    distributions: {
      byDepartment: byDepartment
        .map((d) => ({ label: d.department ?? "—", value: d._count._all }))
        .sort((a, b) => b.value - a.value),
      byGraduationYear: byYear.map((y) => ({ label: String(y.graduationYear), value: y._count._all })),
      donationStatus: statusFrom(donationRows),
      jobStatus: statusFrom(jobRows),
      eventStatus: statusFrom(eventRows),
      topCompanies: topCompanies.map((c) => ({ label: c.currentCompany ?? "—", value: c._count._all })),
      topCities: topCities.map((c) => ({ label: c.city ?? "—", value: c._count._all })),
    },
  };
};

/* -------------------------------------------------------------------------- */
/*  Bulk email to filtered alumni.                                            */
/* -------------------------------------------------------------------------- */

const MAX_BULK_RECIPIENTS = 5000;
const stripHtml = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const personalize = (
  str: string,
  r: { firstName: string; lastName: string; email: string },
) =>
  str
    .replaceAll("{{name}}", `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim())
    .replaceAll("{{firstName}}", r.firstName ?? "")
    .replaceAll("{{email}}", r.email);

/** Count the alumni that match a filter set (drives the composer's preview). */
export const countAlumniRecipients = (filters: AlumniFilter) =>
  prisma.profile.count({ where: buildAlumniWhere(filters) });

/**
 * Send a branded HTML email (with optional attachments) to every approved
 * alumnus matching the given filters. Body/subject support `{{name}}`,
 * `{{firstName}}` and `{{email}}` placeholders for personalization.
 */
export const sendAlumniBulkEmail = async (
  actorId: string,
  input: {
    filters: AlumniFilter;
    subject: string;
    html: string;
    attachments?: { key: string; filename: string }[];
  },
) => {
  const profiles = await prisma.profile.findMany({
    where: buildAlumniWhere(input.filters),
    select: { user: { select: { email: true, firstName: true, lastName: true } } },
    take: MAX_BULK_RECIPIENTS,
  });
  const recipients = profiles
    .map((p) => p.user)
    .filter((u): u is { email: string; firstName: string; lastName: string } => !!u?.email);

  if (recipients.length === 0) return { recipientCount: 0, sent: 0, failed: 0 };

  // Resolve attachment object keys to URLs the mailer can attach.
  const storage = getStorage();
  const attachments = input.attachments?.length
    ? await Promise.all(
        input.attachments.map(async (a) => ({
          filename: a.filename,
          path: await storage.presignDownload(a.key),
        })),
      )
    : undefined;

  const mails = recipients.map((r) => {
    const bodyHtml = personalize(input.html, r);
    const subject = personalize(input.subject, r);
    return {
      to: r.email,
      subject,
      text: stripHtml(bodyHtml),
      html: wrapHtmlEmail(subject, bodyHtml),
      attachments,
    };
  });

  const { sent, failed } = await sendBulkEmails(mails);

  await prisma.auditLog.create({
    data: {
      actorId,
      action: "alumni.bulk_email",
      entity: "Alumni",
      metadata: {
        subject: input.subject,
        recipientCount: recipients.length,
        sent,
        failed,
        filters: input.filters as unknown as Prisma.InputJsonValue,
      },
    },
  });

  return { recipientCount: recipients.length, sent, failed };
};
