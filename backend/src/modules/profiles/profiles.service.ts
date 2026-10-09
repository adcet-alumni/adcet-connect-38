import { prisma } from "../../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { NotFound } from "../../lib/errors.js";
import { resolveProfileLocation } from "../../lib/geocode.js";
import { personSelect } from "../../lib/selects.js";
import { getStorage } from "../../storage/index.js";
import { logger } from "../../lib/logger.js";

const profileInclude = {
  experiences: { orderBy: { startDate: "desc" as const } },
  educations: { orderBy: { startYear: "desc" as const } },
  skills: { include: { skill: true } },
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  // Read-only here — chapter membership is changed via POST /chapters/join,
  // which enforces the alumni-only rule.
  chapter: { select: { id: true, slug: true, name: true, city: true, isActive: true } },
};

export const getMyProfile = async (userId: string) => {
  const profile = await prisma.profile.findUnique({ where: { userId }, include: profileInclude });
  if (!profile) throw NotFound("Profile not found");
  return profile;
};

/**
 * What one member may see of another: who they are, where they studied and
 * what they do now — the profile as a page, not the row as stored.
 *
 * Everything left out is left out on purpose. `phone`, `birthDay`/`birthMonth`
 * and `rollNumber` are contact and identity details an alumnus gave the college,
 * not the network; `admissionYear` is derived; `locationId` is map plumbing; and
 * `user.email` never belongs in a payload a member can enumerate. Before this,
 * `GET /profiles/:userId` handed the entire `Profile` row plus the email to any
 * approved member — a directory of phone numbers for anyone who read the API.
 */
const memberViewSelect = {
  userId: true,
  avatarKey: true,
  bannerKey: true,
  bio: true,
  city: true,
  country: true,
  department: true,
  degree: true,
  graduationYear: true,
  currentCompany: true,
  currentRole: true,
  linkedinUrl: true,
  showLinkedin: true,
  githubUrl: true,
  twitterUrl: true,
  websiteUrl: true,
  chapter: { select: { id: true, slug: true, name: true, city: true, isActive: true } },
  experiences: { orderBy: { startDate: "desc" as const } },
  educations: { orderBy: { startYear: "desc" as const } },
  skills: { include: { skill: true } },
  user: { select: personSelect() },
} satisfies Prisma.ProfileSelect;

/** Who is asking — the owner and admins see the row, everyone else the page. */
export interface ProfileViewer {
  id: string;
  isAdmin: boolean;
}

/**
 * Another member's profile.
 *
 * An admin still sees the whole row (they administer these accounts), and so
 * does the owner asking about themselves. Every other member gets
 * `memberViewSelect`, with `showLinkedin` applied on top: that flag is the
 * owner's veto on their LinkedIn link, so it has to hold on every surface that
 * hands the link to somebody else — honouring it on the directory card while
 * this endpoint still returned it would make the switch a decoration.
 */
export const getProfileByUserId = async (userId: string, viewer?: ProfileViewer) => {
  if (viewer?.isAdmin || (viewer && viewer.id === userId)) {
    const own = await prisma.profile.findUnique({ where: { userId }, include: profileInclude });
    if (!own) throw NotFound("Profile not found");
    return own;
  }

  const profile = await prisma.profile.findUnique({ where: { userId }, select: memberViewSelect });
  if (!profile) throw NotFound("Profile not found");

  const { showLinkedin, linkedinUrl, ...rest } = profile;
  return { ...rest, linkedinUrl: showLinkedin ? linkedinUrl : null };
};

/**
 * Re-place the profile on the alumni map whenever the edit touches where the
 * alumnus lives.
 *
 * Only the offline gazetteer is consulted (`allowRemote` stays false), so a
 * profile save is a couple of indexed queries and never waits on an outbound
 * geocoder. A city the gazetteer doesn't know resolves to `null` and is picked
 * up by the nightly backfill instead — the alumnus is briefly unplaced, which
 * is much better than a slow or failing save.
 */
const withResolvedLocation = async (userId: string, data: Record<string, unknown>) => {
  if (!("city" in data) && !("country" in data)) return data;

  const current =
    "country" in data
      ? null
      : await prisma.profile.findUnique({ where: { userId }, select: { country: true } });
  const country = "country" in data ? (data.country as string | null) : current?.country ?? null;

  return { ...data, locationId: await resolveProfileLocation(data.city as string | null, country) };
};

export const updateMyProfile = async (userId: string, data: Record<string, unknown>) => {
  const withLocation = await withResolvedLocation(userId, data);

  // Capture the old keys before overwriting so we can clean up storage.
  const replacingAvatar = "avatarKey" in data;
  const replacingBanner = "bannerKey" in data;
  let oldAvatarKey: string | null = null;
  let oldBannerKey: string | null = null;

  if (replacingAvatar || replacingBanner) {
    const existing = await prisma.profile.findUnique({
      where: { userId },
      select: {
        ...(replacingAvatar && { avatarKey: true }),
        ...(replacingBanner && { bannerKey: true }),
      },
    });
    if (existing) {
      oldAvatarKey = (existing as Record<string, unknown>).avatarKey as string | null;
      oldBannerKey = (existing as Record<string, unknown>).bannerKey as string | null;
    }
  }

  const profile = await prisma.profile.upsert({
    where: { userId },
    update: withLocation,
    create: { userId, ...withLocation },
  });

  // Best-effort delete old storage objects that were replaced.
  const keysToDelete: string[] = [];
  if (replacingAvatar && oldAvatarKey && oldAvatarKey !== data.avatarKey) {
    keysToDelete.push(oldAvatarKey);
  }
  if (replacingBanner && oldBannerKey && oldBannerKey !== data.bannerKey) {
    keysToDelete.push(oldBannerKey);
  }
  if (keysToDelete.length > 0) {
    const storage = getStorage();
    Promise.allSettled(keysToDelete.map((key) => storage.delete(key))).catch((err) =>
      logger.warn({ err, userId, keys: keysToDelete }, "Failed to clean up old profile media"),
    );
  }

  return profile;
};

export const addExperience = async (userId: string, data: Record<string, unknown>) => {
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) throw NotFound();
  return prisma.workExperience.create({
    data: { ...(data as Prisma.WorkExperienceUncheckedCreateInput), profileId: profile.id },
  });
};

export const removeExperience = (id: string) => prisma.workExperience.delete({ where: { id } });

export const addEducation = async (userId: string, data: Record<string, unknown>) => {
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) throw NotFound();
  return prisma.education.create({
    data: { ...(data as Prisma.EducationUncheckedCreateInput), profileId: profile.id },
  });
};

export const removeEducation = (id: string) => prisma.education.delete({ where: { id } });

export const setSkills = async (userId: string, skillNames: string[]) => {
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) throw NotFound();
  // Upsert skills then reset profile linkage.
  const skills = await Promise.all(
    skillNames.map((name) =>
      prisma.skill.upsert({ where: { name }, update: {}, create: { name } }),
    ),
  );
  await prisma.profileSkill.deleteMany({ where: { profileId: profile.id } });
  await prisma.profileSkill.createMany({
    data: skills.map((s) => ({ profileId: profile.id, skillId: s.id })),
  });
  return skills;
};

export const getPreferences = async (userId: string) => {
  const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
  // Return defaults if not yet created
  return prefs ?? {
    userId,
    notificationsEmail: true,
    notificationsPush: true,
    darkMode: false,
    language: "en",
    theme: "default",
  };
};

export const updatePreferences = async (
  userId: string,
  data: Partial<{ theme: string; darkMode: boolean; notificationsEmail: boolean; notificationsPush: boolean }>,
) =>
  prisma.userPreferences.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });