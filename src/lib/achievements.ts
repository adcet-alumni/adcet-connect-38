/**
 * Who an achievement is *about*, and how to reach them.
 *
 * Two things vary and every surface has to agree on both, so they live here
 * rather than in each card:
 *
 * **The byline.** Usually the author's own account, because an alumnus submits
 * their own achievement. But the alumni office can record one for somebody who
 * never registered — a retired professor, a guest, an alumnus off the portal —
 * and then the row is owned by the admin who filed it while `achieverName`
 * carries the real name. Reading `user` alone would byline those entries
 * "Admin User".
 *
 * **The LinkedIn link.** The API resolves it (an admin-typed link, else the
 * author's profile link if their "Show my LinkedIn" switch allows it) and sends
 * `linkedinUrl` already decided — `null` when there is none, which is the
 * ordinary case rather than an error. Public endpoints never send the field at
 * all. So every surface does the same thing: render the icon if a usable link
 * arrived, and otherwise render nothing. No placeholder, no dead icon, no
 * message about a missing profile.
 */
import { safeExternalUrl } from "@/lib/urls";

export interface AchievementAuthorship {
  /** Set only when an admin recorded the achievement for a non-member. */
  achieverName?: string | null;
  /** Resolved by the API; absent on public payloads. */
  linkedinUrl?: string | null;
  user?: { firstName?: string | null; lastName?: string | null } | null;
}

/** The name to print under an achievement. */
export const achieverOf = (a: AchievementAuthorship, fallback = "Alumnus"): string => {
  const named = a.achieverName?.trim();
  if (named) return named;
  const account = `${a.user?.firstName ?? ""} ${a.user?.lastName ?? ""}`.trim();
  return account || fallback;
};

/** Initials for the avatar bubble, from whichever name the byline uses. */
export const achieverInitials = (a: AchievementAuthorship): string => {
  const [first = "", second = ""] = achieverOf(a, "").split(/\s+/);
  return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase() || "A";
};

/**
 * The achiever's LinkedIn, or `undefined` when there is nothing safe to link.
 *
 * Passing it through `safeExternalUrl` matters as much as the null check: rows
 * written before the `http(s)`-only rule could hold anything, and this becomes
 * an `<a href>`.
 */
export const achieverLinkedin = (a: AchievementAuthorship): string | undefined =>
  safeExternalUrl(a.linkedinUrl);
