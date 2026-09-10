/**
 * What counts as a "complete" profile.
 *
 * Sign-up collects all of this up front (`registerSchema`), so an account made
 * through the form is complete on creation. Accounts that predate that rule —
 * and any the office imports — are not, and the frontend forces them through
 * `/complete-profile`, which posts the same fields to
 * `POST /auth/complete-profile`.
 *
 * Keep this list in step with the mandatory half of `registerSchema` — a field
 * that is required at sign-up but missing here is a field the second door
 * would let an account skip.
 */

/** Profile columns an account must have filled before it can be used. */
export const REQUIRED_PROFILE_FIELDS = [
  "department",
  "degree",
  "graduationYear",
  "birthDay",
  "birthMonth",
  "phone",
  "city",
  "currentCompany",
  "currentRole",
] as const;

export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];

type ProfileLike = Partial<Record<RequiredProfileField, unknown>> | null | undefined;

/** Fields still missing — drives both the boolean below and admin diagnostics. */
export const missingProfileFields = (profile: ProfileLike): RequiredProfileField[] => {
  if (!profile) return [...REQUIRED_PROFILE_FIELDS];
  return REQUIRED_PROFILE_FIELDS.filter((field) => {
    const value = profile[field];
    if (value == null) return true;
    // Guard against columns holding "" or "   " from older, laxer writes.
    return typeof value === "string" && value.trim() === "";
  });
};

export const isProfileComplete = (profile: ProfileLike): boolean =>
  missingProfileFields(profile).length === 0;
