import { prisma } from "../../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { paginate, paginationMeta, type PaginationQuery } from "../../lib/pagination.js";
import type { DirectorySort } from "./alumni.validators.js";

/**
 * Free-text directory search covers **name and company only** — department and
 * graduation year are deliberately excluded so they can't be typed at; those
 * two are filters, not search terms.
 *
 * Each whitespace-separated word must match something, which is what makes a
 * full name work: "asha kulkarni" needs "asha" and "kulkarni" to hit, though
 * either may land on the first name, the last name or the employer.
 */
const nameAndCompanyMatch = (term: string): Prisma.ProfileWhereInput[] =>
  term
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => ({
      OR: [
        { user: { firstName: { contains: word, mode: "insensitive" } } },
        { user: { lastName: { contains: word, mode: "insensitive" } } },
        { currentCompany: { contains: word, mode: "insensitive" } },
      ],
    }));

/**
 * Exactly the columns the directory card renders — nothing else.
 *
 * A directory row is read by every approved member, so `findMany` must never
 * hand back the whole Profile: the row also holds a phone number, a birthday
 * and a home city trail that the card has never displayed. Selecting the fields
 * the UI actually uses is what keeps "rendered" and "sent" the same list.
 *
 * `showLinkedin` is selected only so `toCard` can act on it; it is stripped
 * before the payload leaves.
 */
const cardSelect = {
  id: true,
  userId: true,
  city: true,
  currentCompany: true,
  currentRole: true,
  department: true,
  graduationYear: true,
  avatarKey: true,
  linkedinUrl: true,
  showLinkedin: true,
  user: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ProfileSelect;

type CardRow = Prisma.ProfileGetPayload<{ select: typeof cardSelect }>;

/** Apply the owner's own veto, then drop the flag itself from the payload. */
const toCard = ({ showLinkedin, linkedinUrl, ...rest }: CardRow) => ({
  ...rest,
  linkedinUrl: showLinkedin ? linkedinUrl : null,
});

export interface DirectoryQuery extends PaginationQuery {
  q?: string;
  city?: string;
  company?: string;
  department?: string;
  departments?: string[];
  graduationYear?: number;
  graduationYears?: number[];
  graduationYearMin?: number;
  graduationYearMax?: number;
  sort?: DirectorySort;
}

/** Who is looking — the basis for the relevance ordering. */
export interface Viewer {
  department: string | null;
  graduationYear: number | null;
}

const buildWhere = (q: DirectoryQuery): Prisma.ProfileWhereInput => ({
  user: { status: "APPROVED" },
  ...(q.city && { city: { contains: q.city, mode: "insensitive" } }),
  ...(q.company && { currentCompany: { contains: q.company, mode: "insensitive" } }),
  ...(q.department && { department: { contains: q.department, mode: "insensitive" } }),
  // Multi-select filters: within a filter the values OR together.
  ...(q.departments?.length && { department: { in: q.departments } }),
  ...(q.graduationYear && { graduationYear: q.graduationYear }),
  ...(q.graduationYears?.length && { graduationYear: { in: q.graduationYears } }),
  ...((q.graduationYearMin || q.graduationYearMax) && {
    graduationYear: {
      ...(q.graduationYearMin && { gte: q.graduationYearMin }),
      ...(q.graduationYearMax && { lte: q.graduationYearMax }),
    },
  }),
  ...(q.q?.trim() && { AND: nameAndCompanyMatch(q.q) }),
});

/**
 * One slice of the relevance order: a narrowing predicate plus the ordering to
 * use inside it. The slices are concatenated in the order they are listed.
 */
type Band = { where: Prisma.ProfileWhereInput; orderBy: Prisma.ProfileOrderByWithRelationInput[] };

const byName: Prisma.ProfileOrderByWithRelationInput[] = [
  { user: { firstName: "asc" } },
  { user: { lastName: "asc" } },
];

/**
 * "People like me, nearest first."
 *
 * The bands below encode the alumni office's reading of relevance: your own
 * department before any other, and within a department your own batch, then the
 * batches *above* you (the seniors you were at college with), then the juniors.
 * Ordering `graduationYear` descending from your year outwards gives exactly
 * that, which is why this is expressible as plain Prisma `orderBy` on an
 * indexed column instead of a hand-written SQL ranking expression.
 *
 * A viewer with no department (or no batch) simply has fewer bands — an
 * incomplete profile degrades to the plain "newest batch first" listing rather
 * than to an error.
 */
const relevanceBands = (viewer: Viewer): Band[] => {
  const { department, graduationYear: year } = viewer;

  /** The three-way split of one department slice around the viewer's batch. */
  const aroundBatch = (scope: Prisma.ProfileWhereInput): Band[] => {
    if (year == null) return [{ where: scope, orderBy: [{ graduationYear: "desc" }, ...byName] }];
    return [
      // Own batch first, then upwards through the seniors.
      { where: { ...scope, graduationYear: { lte: year } }, orderBy: [{ graduationYear: "desc" }, ...byName] },
      // Then the juniors, nearest batch first.
      { where: { ...scope, graduationYear: { gt: year } }, orderBy: [{ graduationYear: "asc" }, ...byName] },
      // Profiles with no batch on file trail their department.
      { where: { ...scope, graduationYear: null }, orderBy: byName },
    ];
  };

  if (!department) return aroundBatch({});
  return [
    ...aroundBatch({ department }),
    ...aroundBatch({ NOT: { department } }),
    // `NOT: { department }` excludes NULLs in SQL, so name them explicitly or
    // a member with no department on file would fall out of the listing.
    ...aroundBatch({ department: null }),
  ];
};

const SORTS: Record<Exclude<DirectorySort, "relevant">, Prisma.ProfileOrderByWithRelationInput[]> = {
  batch: [{ graduationYear: "desc" }, ...byName],
  name: byName,
};

/**
 * Walk the bands until the requested page is filled.
 *
 * The bands **partition** the result set — own department, other departments,
 * no department on file, each split three ways around the viewer's batch — so
 * their counts add up to exactly what a plain sort would report. That is what
 * lets the total come from a single `count` over the unbanded predicate rather
 * than from summing nine of them.
 *
 * Band counts are then only needed to answer "how far into the bands does this
 * page start", which is a question page 1 does not ask. Counting all nine
 * up front cost nine `COUNT(*)` on every directory open — the landing screen of
 * the member portal — and each one carries the caller's search terms, so a
 * two-word query multiplied into eighteen scans of Profile joined to User.
 * They are now counted lazily, one band at a time, only until the offset is
 * consumed: page 1 issues none, and a deep page issues only as many as it
 * has to skip past.
 */
const searchByRelevance = async (q: DirectoryQuery, viewer: Viewer) => {
  const base = buildWhere(q);
  const bands = relevanceBands(viewer).map((b) => ({
    ...b,
    where: { AND: [base, b.where] } satisfies Prisma.ProfileWhereInput,
  }));

  const { skip, take } = paginate(q);

  // The total does not depend on the banding, so it runs alongside the walk
  // rather than gating it.
  const totalPromise = prisma.profile.count({ where: base });

  const items: CardRow[] = [];
  let cursor = skip;

  for (const band of bands) {
    if (items.length >= take) break;

    if (cursor > 0) {
      // Only reached while the requested page still starts beyond this band.
      const inBand = await prisma.profile.count({ where: band.where });
      if (cursor >= inBand) {
        cursor -= inBand; // the whole band sits before the requested page
        continue;
      }
    }

    const rows = await prisma.profile.findMany({
      where: band.where,
      select: cardSelect,
      orderBy: band.orderBy,
      skip: cursor,
      take: take - items.length,
    });
    items.push(...rows);
    cursor = 0;
  }

  return {
    items: items.map(toCard),
    pagination: paginationMeta(await totalPromise, q),
    // What the ordering was based on, so the page can say so out loud instead
    // of silently reordering itself.
    relevance: viewer,
  };
};

/**
 * The viewer's own department and batch — the basis of the default ordering.
 * A member who has neither (an admin, say) still gets a listing; it just falls
 * back to the batch order.
 */
export const viewerFor = async (userId: string): Promise<Viewer> => {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { department: true, graduationYear: true },
  });
  return { department: profile?.department ?? null, graduationYear: profile?.graduationYear ?? null };
};

/**
 * The directory listing.
 *
 * Default order is relevance to `viewer` — the same query returns a different
 * first page for every member, which is the whole point: an alumnus opening the
 * directory should land among their own department and batch rather than on
 * whoever graduated most recently. Nobody is hidden by it; `sort=batch` and
 * `sort=name` give the old, viewer-independent orders.
 */
export const search = async (q: DirectoryQuery, viewer: Viewer) => {
  const sort = q.sort ?? "relevant";
  if (sort === "relevant") return searchByRelevance(q, viewer);

  const where = buildWhere(q);
  const [items, total] = await Promise.all([
    prisma.profile.findMany({
      where,
      select: cardSelect,
      orderBy: SORTS[sort],
      ...paginate(q),
    }),
    prisma.profile.count({ where }),
  ]);
  // Reported on every sort so the payload has one shape; the page only says
  // "sorted for you" when the ordering actually used it.
  return { items: items.map(toCard), pagination: paginationMeta(total, q), relevance: viewer };
};
