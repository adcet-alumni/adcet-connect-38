import { prisma } from "../../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { BadRequest, Forbidden, NotFound } from "../../lib/errors.js";
import { paginate, paginationMeta, type PaginationQuery } from "../../lib/pagination.js";
import { personSelect } from "../../lib/selects.js";
import type { AppRoleName } from "../../config/constants.js";
import { notify } from "../notifications/notifications.service.js";
import { sendEmail, sendBulkEmails } from "../../lib/mailer.js";
import { logger } from "../../lib/logger.js";
import { getStorage } from "../../storage/index.js";
import {
  achievementApprovedEmail,
  achievementAnnouncementEmail,
} from "../../lib/email-templates.js";

type Caller = { sub: string; roles: AppRoleName[] };
const isAdmin = (c?: Caller) => !!c?.roles.includes("ADMIN");

/** SiteSection key that stores the newline/comma-separated authority recipient emails. */
export const ACHIEVEMENT_RECIPIENTS_KEY = "achievement_recipients";

/** Read + parse the configured "higher authority" notification emails. */
const getAuthorityRecipients = async (): Promise<string[]> => {
  const section = await prisma.siteSection.findUnique({
    where: { key: ACHIEVEMENT_RECIPIENTS_KEY },
  });
  if (!section?.body) return [];
  return Array.from(
    new Set(
      section.body
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    ),
  );
};

type AchievementStatus = "PENDING" | "APPROVED" | "REJECTED";
export type AchievementInput = Omit<Prisma.AchievementUncheckedCreateInput, "userId">;

/**
 * The author, plus the two profile columns needed to resolve their LinkedIn.
 * The profile half never leaves the service — `withByline` folds it into a
 * single `linkedinUrl` and drops it.
 */
const authorSelect = (includeEmail = false) => ({
  select: {
    ...personSelect(includeEmail),
    profile: { select: { linkedinUrl: true, showLinkedin: true } },
  },
});

type AuthoredRow = {
  achieverName?: string | null;
  achieverLinkedinUrl?: string | null;
  user?: {
    profile?: { linkedinUrl: string | null; showLinkedin: boolean } | null;
  } | null;
};

/**
 * Resolve the achiever's LinkedIn for a portal reader.
 *
 * Two sources, in order: the link an admin typed when recording somebody
 * else's achievement, then the author's own profile — and the profile link only
 * if their `showLinkedin` switch allows it, because that switch is a promise
 * made on the profile page and an achievement is another place the link would
 * otherwise appear. Neither present is the ordinary case, not an error: the
 * field comes back `null` and the card simply has no icon.
 *
 * Deliberately *not* applied to the public feed and the shareable page — a
 * profile link is for fellow alumni, not for anonymous visitors.
 */
const withByline = <T extends AuthoredRow>(row: T) => {
  const { achieverLinkedinUrl, user, ...rest } = row;
  const profile = user?.profile;

  // An `achieverName` means the row is about somebody who is *not* the account
  // it hangs off — an admin filed it, so `user` is that admin. Only the typed
  // link can apply; falling through to the profile would put the admin's own
  // LinkedIn under a stranger's name.
  const aboutSomeoneElse = row.achieverName != null;
  const linkedinUrl = aboutSomeoneElse
    ? achieverLinkedinUrl ?? null
    : // Otherwise the row is about its own author, and their switch decides —
      // including over a link an admin typed. "Don't show my LinkedIn" cannot
      // mean "unless an admin adds it for me".
      (profile?.showLinkedin ? achieverLinkedinUrl ?? profile.linkedinUrl : null) ?? null;

  const author = user ? { ...user } : user;
  if (author) delete (author as { profile?: unknown }).profile;
  return { ...rest, user: author, linkedinUrl };
};

export const list = async (
  q: PaginationQuery & { q?: string; status?: AchievementStatus; userId?: string; mine?: boolean },
  caller?: Caller,
) => {
  const filters: Prisma.AchievementWhereInput[] = [];

  if (isAdmin(caller)) {
    if (q.status) filters.push({ status: q.status });
    if (q.userId) filters.push({ userId: q.userId });
  } else {
    // A non-admin may read approved work from anyone, and their own
    // submissions at any status — but never somebody else's unreviewed or
    // rejected entry. Previously `status` was taken straight from the query,
    // so `?status=PENDING` exposed every user's unmoderated submission.
    if (q.mine) {
      filters.push({ userId: caller?.sub ?? "" });
      if (q.status) filters.push({ status: q.status });
    } else {
      filters.push({ status: "APPROVED" });
      if (q.userId) filters.push({ userId: q.userId });
    }
  }

  if (q.q) {
    filters.push({
      OR: [
        { title: { contains: q.q, mode: "insensitive" } },
        { description: { contains: q.q, mode: "insensitive" } },
      ],
    });
  }

  const where: Prisma.AchievementWhereInput = filters.length ? { AND: filters } : {};
  const [items, total] = await Promise.all([
    prisma.achievement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { user: authorSelect() },
      ...paginate(q),
    }),
    prisma.achievement.count({ where }),
  ]);
  return { items: items.map(withByline), pagination: paginationMeta(total, q) };
};

/** An alumnus submitting their own achievement — always PENDING review. */
export const create = (caller: Caller, data: AchievementInput) =>
  prisma.achievement.create({ data: { ...data, userId: caller.sub } });

export type AdminAchievementInput = AchievementInput & {
  userId?: string;
  achieverName?: string;
  achieverLinkedinUrl?: string;
};

/**
 * An admin recording somebody else's achievement.
 *
 * Straight to APPROVED and silent: the admin *is* the moderation step, so
 * queueing their own entry for their own approval would be a click with no
 * decision in it — and the office adds historical entries in batches, which is
 * not something to mail the whole authority list about one at a time.
 *
 * When `userId` names a member the row is filed under *them*, so it appears on
 * their achievements exactly as if they had submitted it, and `achieverName`
 * stays null — their account is the name. Otherwise the row belongs to the
 * admin (somebody has to own it) and `achieverName` is what the byline reads.
 */
export const adminCreate = async (caller: Caller, data: AdminAchievementInput) => {
  const { userId, achieverName, ...rest } = data;

  if (userId) {
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!target) throw NotFound("That alumnus was not found");
    if (target.status !== "APPROVED") {
      throw BadRequest("That account is not approved yet");
    }
  }

  return prisma.achievement.create({
    data: {
      ...rest,
      userId: userId ?? caller.sub,
      achieverName: userId ? null : achieverName,
      status: "APPROVED",
    },
  });
};

export const getById = async (id: string, caller?: Caller) => {
  const item = await prisma.achievement.findUnique({
    where: { id },
    // The author's email is admin-only: this is the detail page an author and
    // any approved member can open, and it renders a byline, not a contact.
    include: { user: authorSelect(isAdmin(caller)) },
  });
  if (!item) throw NotFound();
  return withByline(item);
};

export const update = async (caller: Caller, id: string, data: Prisma.AchievementUpdateInput) => {
  const existing = await prisma.achievement.findUnique({ where: { id } });
  if (!existing) throw NotFound();
  if (existing.userId !== caller.sub && !isAdmin(caller)) throw Forbidden();

  // Who an achievement is *about* is an admin's call. An author editing their
  // own entry may not rename the achiever or point the link elsewhere, so the
  // fields are dropped rather than trusted — the same reason a role never
  // arrives from client input.
  const patch = { ...data };
  if (!isAdmin(caller)) {
    delete patch.achieverName;
    delete patch.achieverLinkedinUrl;
  }
  const updated = await prisma.achievement.update({ where: { id }, data: patch });

  // Best-effort cleanup of old storage objects when keys are replaced.
  const keysToDelete: string[] = [];
  if (typeof data.imageKey === "string" && existing.imageKey && existing.imageKey !== data.imageKey) {
    keysToDelete.push(existing.imageKey);
  }
  if (typeof data.attachmentKey === "string" && existing.attachmentKey && existing.attachmentKey !== data.attachmentKey) {
    keysToDelete.push(existing.attachmentKey);
  }
  if (keysToDelete.length > 0) {
    const storage = getStorage();
    Promise.allSettled(keysToDelete.map((key) => storage.delete(key))).catch((err) =>
      logger.warn({ err, id, keys: keysToDelete }, "Failed to clean up old achievement media"),
    );
  }

  return updated;
};

export const remove = async (caller: Caller, id: string) => {
  const existing = await prisma.achievement.findUnique({ where: { id } });
  if (!existing) throw NotFound();
  if (existing.userId !== caller.sub && !isAdmin(caller)) throw Forbidden();
  await prisma.achievement.delete({ where: { id } });

  // Best-effort cleanup of storage objects.
  const keysToDelete = [existing.imageKey, existing.attachmentKey].filter(Boolean) as string[];
  if (keysToDelete.length > 0) {
    const storage = getStorage();
    Promise.allSettled(keysToDelete.map((key) => storage.delete(key))).catch((err) =>
      logger.warn({ err, id, keys: keysToDelete }, "Failed to clean up deleted achievement media"),
    );
  }
};

export const moderate = async (
  id: string,
  status: "APPROVED" | "REJECTED",
  reason?: string,
) => {
  const achievement = await prisma.achievement.update({
    where: { id },
    data: { status, rejectionReason: status === "REJECTED" ? reason ?? null : null },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });
  const verb = status === "APPROVED" ? "approved" : "rejected";
  const authorName = `${achievement.user.firstName ?? ""} ${achievement.user.lastName ?? ""}`.trim() || "Alumnus";

  // In-app notification for the author (always).
  await notify(achievement.userId, {
    type: `achievement.${verb}`,
    title: `Your achievement was ${verb}`,
    body:
      status === "REJECTED"
        ? `"${achievement.title}" was rejected.${reason ? ` Reason: ${reason}` : ""}`
        : `"${achievement.title}" is now visible to alumni.`,
    data: { achievementId: achievement.id },
    // Rejections rely on the generic notification email; approvals send a
    // richer branded email below, so avoid double-emailing the author.
    sendEmailToo: status === "REJECTED",
  });

  // On approval, send branded emails to the author and college authorities.
  if (status === "APPROVED") {
    const emailData = {
      id: achievement.id,
      title: achievement.title,
      description: achievement.description,
      category: achievement.category,
      occurredOn: achievement.occurredOn,
      link: achievement.link,
    };
    try {
      const authorMail = achievementApprovedEmail(emailData, authorName);
      await sendEmail({
        to: achievement.user.email,
        subject: authorMail.subject,
        text: authorMail.text,
        html: authorMail.html,
      });
    } catch (e) {
      logger.error({ err: e, id }, "failed to email achievement author on approval");
    }
    try {
      const recipients = await getAuthorityRecipients();
      if (recipients.length) {
        const announce = achievementAnnouncementEmail(emailData, authorName);
        await sendBulkEmails(
          recipients.map((to) => ({
            to,
            subject: announce.subject,
            text: announce.text,
            html: announce.html,
          })),
        );
      }
    } catch (e) {
      logger.error({ err: e, id }, "failed to email authorities on achievement approval");
    }
  }

  return achievement;
};

/**
 * Public feed of the latest approved achievements — powers the home-page
 * slider. No auth required; only APPROVED rows and safe fields are exposed.
 */
export const listFeatured = async (limit = 8) =>
  prisma.achievement.findMany({
    where: { status: "APPROVED" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 20),
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      occurredOn: true,
      imageKey: true,
      // The name, so an admin-recorded achievement is bylined correctly. Not
      // `achieverLinkedinUrl` — a personal profile link is not public content.
      achieverName: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });

/**
 * Public single-achievement view (for the shareable /achievements/:id page).
 * Returns only APPROVED achievements — pending/rejected 404 for the public.
 */
export const getPublicById = async (id: string) => {
  const item = await prisma.achievement.findFirst({
    where: { id, status: "APPROVED" },
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      occurredOn: true,
      imageKey: true,
      attachmentKey: true,
      link: true,
      createdAt: true,
      achieverName: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });
  if (!item) throw NotFound();
  return item;
};

export const listPending = async (q: PaginationQuery) => {
  const where = { status: "PENDING" as const };
  const [items, total] = await Promise.all([
    prisma.achievement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { user: authorSelect(true) }, // admin-only moderation queue
      ...paginate(q),
    }),
    prisma.achievement.count({ where }),
  ]);
  return { items: items.map(withByline), pagination: paginationMeta(total, q) };
};