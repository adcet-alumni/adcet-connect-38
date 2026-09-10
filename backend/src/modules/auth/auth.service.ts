/**
 * Auth domain logic. Stateless functions that wrap Prisma + crypto utilities.
 * Controllers stay thin and delegate here.
 */
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../lib/jwt.js";
import { BadRequest, Conflict, ServiceUnavailable, Unauthorized } from "../../lib/errors.js";
import { sendEmail } from "../../lib/mailer.js";
import { emailVerificationOtpEmail, passwordResetEmail } from "../../lib/email-templates.js";
import { logger } from "../../lib/logger.js";
import { getStorage } from "../../storage/index.js";
import { env } from "../../config/env.js";
import {
  admissionYearFor,
  IDENTITY_DOCUMENT_MIME_TYPES,
  PENDING_UPLOAD_RETENTION_HOURS,
  UPLOAD_MAX_BYTES,
  type AppRoleName,
} from "../../config/constants.js";
import { isProfileComplete } from "../../lib/profileCompletion.js";
import { resolveProfileLocation } from "../../lib/geocode.js";
import type { CompleteProfileInput, LoginInput, RegisterInput } from "./auth.validators.js";

const REFRESH_TTL_DAYS = 7;
const RESET_TTL_MINUTES = 60;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/** Best-effort resolution of the frontend base URL for building links. */
const frontendBaseUrl = (): string => {
  const origin = env.CORS_ORIGIN;
  if (!origin || origin === "*") return "http://localhost:8080";
  return origin.split(",")[0].trim();
};

const issueTokens = async (user: { id: string; email: string }, roles: AppRoleName[]) => {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, roles });
  const refreshToken = signRefreshToken(user.id);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { accessToken, refreshToken };
};

/**
 * TEMPORARY testing escape hatch. When mail delivery is impossible (e.g. the
 * host firewalls outbound SMTP), returning the code in the API response lets
 * sign-up be exercised end-to-end. It also lets anyone register an address they
 * do not own, so it must stay off outside throwaway test deployments.
 */
const exposeOtpOnMailFailure = (): boolean =>
  process.env.EXPOSE_OTP_ON_MAIL_FAILURE === "true";

/**
 * Send a 6-digit verification code to an email address that wants to register.
 * Any previous unconsumed codes for the address are invalidated first, so only
 * the latest code works. Throws 409 if the email already has an account.
 *
 * Resolves with `devCode` only under the escape hatch above — otherwise a
 * delivery failure surfaces as 503 so the UI can tell the user to retry.
 */
/**
 * Store the proof-of-study document a sign-up is about to be submitted with.
 *
 * This is the only upload path in the application with no session in front of
 * it, and it has to be: the document is collected *before* the email is
 * verified, which is before there is an account to own the object or a token to
 * authorise it. Four things keep that from being an open door —
 *
 *  - the route is behind `authLimiter`, the same limiter as sign-up itself;
 *  - the type is checked here against `IDENTITY_DOCUMENT_MIME_TYPES` rather
 *    than trusted from the header alone;
 *  - the size is checked against the bytes actually received, not a declared
 *    number, because there is nothing here to declare one; and
 *  - a row that no registration ever claims is swept, with its object, by
 *    `jobs/pendingUploadCleanup.ts`.
 *
 * Returns the row's id, not the key. The caller never learns where the file
 * went, so a guessed or stolen id is worth nothing beyond a single claim, and
 * `register()` is the only thing that can turn one into a stored document.
 */
export const storeIdentityDocument = async (input: {
  fileName: string;
  contentType: string;
  body: Buffer;
}): Promise<{ documentId: string }> => {
  const contentType = input.contentType.split(";")[0].trim().toLowerCase();
  if (!(IDENTITY_DOCUMENT_MIME_TYPES as readonly string[]).includes(contentType)) {
    throw BadRequest("Upload a JPG, PNG, WEBP or PDF of your document.");
  }
  if (input.body.length === 0) throw BadRequest("That file is empty.");
  if (input.body.length > UPLOAD_MAX_BYTES.identity) {
    throw BadRequest(
      `That file is too large — the limit is ${Math.round(UPLOAD_MAX_BYTES.identity / (1024 * 1024))} MB.`,
    );
  }

  // The row is created first so a stored object always has something pointing
  // at it: an insert that fails after a successful upload would leave a file
  // the cleanup job cannot see.
  const pending = await prisma.pendingIdentityDocument.create({
    data: {
      // Replaced below with the real key. A placeholder rather than a nullable
      // column, so the unique index still guards the claim.
      objectKey: `pending:${crypto.randomUUID()}`,
      contentType,
      sizeBytes: input.body.length,
      fileName: input.fileName.slice(0, 200),
    },
  });

  try {
    const stored = await getStorage().upload({
      fileName: input.fileName,
      contentType,
      scope: "identity",
      // No account exists yet, so the key's owner segment is this upload's own
      // id. `uploads.service.ts` resolves the real owner through `Profile`.
      ownerId: pending.id,
      body: input.body,
    });
    await prisma.pendingIdentityDocument.update({
      where: { id: pending.id },
      data: { objectKey: stored.key },
    });
  } catch (err) {
    await prisma.pendingIdentityDocument
      .delete({ where: { id: pending.id } })
      .catch(() => undefined);
    logger.error({ err }, "[auth] failed to store a sign-up identity document");
    throw ServiceUnavailable("We couldn't store that document. Please try again.");
  }

  return { documentId: pending.id };
};

/**
 * Exchange an upload id for the key to write onto the new profile.
 *
 * Single-use by construction: the conditional `updateMany` on `claimedAt` is
 * the claim, so two registrations racing for one document — or one id replayed
 * — leave exactly one winner. Expiry is checked here too, so a document the
 * cleanup job has not reached yet still cannot be claimed after its window.
 */
const claimIdentityDocument = async (documentId: string): Promise<string> => {
  const cutoff = new Date(Date.now() - PENDING_UPLOAD_RETENTION_HOURS * 60 * 60 * 1000);
  const claimed = await prisma.pendingIdentityDocument.updateMany({
    where: { id: documentId, claimedAt: null, createdAt: { gte: cutoff } },
    data: { claimedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw BadRequest(
      "That document upload has expired or was already used. Please upload it again.",
    );
  }
  const row = await prisma.pendingIdentityDocument.findUnique({ where: { id: documentId } });
  if (!row) throw BadRequest("That document upload could not be found. Please upload it again.");
  return row.objectKey;
};

export const sendRegistrationOtp = async (email: string): Promise<{ devCode?: string }> => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw Conflict("Email already registered");

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await prisma.$transaction([
    // Drop this email's older codes (only the latest may be used) and,
    // opportunistically, everyone's expired ones so the table self-cleans.
    prisma.emailVerificationOtp.deleteMany({
      where: { OR: [{ email }, { expiresAt: { lt: new Date() } }] },
    }),
    prisma.emailVerificationOtp.create({
      data: {
        email,
        codeHash: hashToken(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      },
    }),
  ]);

  const mail = emailVerificationOtpEmail(code, OTP_TTL_MINUTES);
  try {
    await sendEmail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    logger.error({ err, email }, "[auth] failed to send registration OTP email");
    if (!exposeOtpOnMailFailure()) {
      throw ServiceUnavailable(
        "We couldn't send the verification email right now. Please try again in a moment.",
      );
    }
    logger.warn(
      { email },
      "[auth] EXPOSE_OTP_ON_MAIL_FAILURE is on — returning the OTP in the API response",
    );
    return { devCode: code };
  }
  return {};
};

/**
 * Consume the latest OTP for this email or throw. Attempts are counted so the
 * 6-digit space can't be brute-forced within a code's lifetime.
 */
const consumeRegistrationOtp = async (email: string, otp: string): Promise<void> => {
  const row = await prisma.emailVerificationOtp.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.expiresAt < new Date()) {
    throw BadRequest("Verification code is invalid or has expired. Please request a new one.");
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    throw BadRequest("Too many incorrect attempts. Please request a new code.");
  }
  if (hashToken(otp) !== row.codeHash) {
    await prisma.emailVerificationOtp.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    throw BadRequest("Incorrect verification code.");
  }
  await prisma.emailVerificationOtp.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });
};

/**
 * Prisma's unique-violation code. `register` catches it explicitly rather than
 * relying on the pre-flight lookup alone: two sign-ups for the same address can
 * interleave between the check and the insert, and only the database can
 * arbitrate that race.
 */
const UNIQUE_VIOLATION = "P2002";

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

export const register = async (input: RegisterInput) => {
  // `email` arrives already trimmed and lowercased from `emailSchema`, so this
  // lookup and the unique index agree on what "the same address" means.
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw Conflict("Email already registered");

  await consumeRegistrationOtp(input.email, input.otp);

  /*
   * Claimed after the OTP, before the account. If the create below fails the
   * document stays claimed and effectively orphaned — which is the right way
   * round: re-registering asks for a fresh upload, whereas an unclaimed id that
   * survived a failure could be replayed onto a different account.
   */
  const identityDocumentKey = await claimIdentityDocument(input.identityDocumentId);

  // Hardcoded, never taken from the request. The only paths to ADMIN are an
  // existing admin granting it and `seed-admin.ts` bootstrapping the first one.
  const role: AppRoleName = "ALUMNI";
  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        // PENDING until an admin approves. Proving the email address is not
        // proof of being an ADCET alumnus — only the office can decide that.
        status: "PENDING",
        // Ownership of the address was just proven via OTP.
        emailVerifiedAt: new Date(),
        roles: { create: { role } },
        profile: {
          create: {
            department: input.department,
            degree: input.degree,
            // Not collected — implied by the graduation year and course length.
            admissionYear: admissionYearFor(input.degree, input.graduationYear),
            graduationYear: input.graduationYear,
            birthDay: input.birthDay,
            birthMonth: input.birthMonth,
            linkedinUrl: input.linkedinUrl,
            githubUrl: input.githubUrl || undefined,
            twitterUrl: input.twitterUrl || undefined,
            websiteUrl: input.websiteUrl || undefined,
            phone: input.phone,
            city: input.city,
            // Places the new alumnus on the map straight away when the city is
            // a known one; unknown cities are resolved by the backfill job.
            locationId: await resolveProfileLocation(input.city, null),
            bio: input.bio || undefined,
            currentCompany: input.currentCompany,
            currentRole: input.currentRole,
            // What the reviewing admin actually checks the application against.
            identityDocumentKey,
          },
        },
        preferences: { create: {} },
      },
      // `publicUser` reads the profile to report `profileComplete`.
      include: { profile: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Conflict("Email already registered");
    throw err;
  }

  const tokens = await issueTokens(user, [role]);
  return { user: publicUser(user, [role]), ...tokens };
};

export const login = async (input: LoginInput) => {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { roles: true, profile: true },
  });
  if (!user || !user.passwordHash) throw Unauthorized("Invalid credentials");
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw Unauthorized("Invalid credentials");

  const roles = user.roles.map((r) => r.role as AppRoleName);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const tokens = await issueTokens(user, roles);
  return { user: publicUser(user, roles), ...tokens };
};

export const refresh = async (refreshToken: string) => {
  let payload: ReturnType<typeof verifyRefreshToken>;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw Unauthorized("Invalid refresh token");
  }
  const tokenRow = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (!tokenRow || tokenRow.revokedAt || tokenRow.expiresAt < new Date()) {
    throw Unauthorized("Refresh token expired or revoked");
  }
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { roles: true },
  });
  if (!user) throw Unauthorized();

  // Rotate: revoke old, issue new pair.
  await prisma.refreshToken.update({
    where: { id: tokenRow.id },
    data: { revokedAt: new Date() },
  });
  const roles = user.roles.map((r) => r.role as AppRoleName);
  return issueTokens(user, roles);
};

export const logout = async (refreshToken: string) => {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

/**
 * Fill in the mandatory profile for an account that doesn't have one.
 *
 * `registerSchema` collects every required field, so a signup made through the
 * form is complete the moment it exists. This is the safety net for the ones
 * that aren't: accounts created before that was true, and any the office
 * imports. `ProtectedRoute` funnels them here rather than into a portal whose
 * every screen would be missing its data.
 *
 * The account stays PENDING: completing the profile is what makes it
 * *reviewable*, not approved. An admin still decides.
 */
export const completeProfile = async (userId: string, input: CompleteProfileInput) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, profile: true },
  });
  if (!user) throw Unauthorized();

  const profileData = {
    department: input.department,
    degree: input.degree,
    // Derived, never asked for — same rule as form sign-up.
    admissionYear: admissionYearFor(input.degree, input.graduationYear),
    graduationYear: input.graduationYear,
    birthDay: input.birthDay,
    birthMonth: input.birthMonth,
    phone: input.phone,
    city: input.city,
    locationId: await resolveProfileLocation(input.city, null),
    currentCompany: input.currentCompany,
    currentRole: input.currentRole,
    linkedinUrl: input.linkedinUrl,
    githubUrl: input.githubUrl || undefined,
    twitterUrl: input.twitterUrl || undefined,
    websiteUrl: input.websiteUrl || undefined,
    bio: input.bio || undefined,
  };

  // `upsert` because the profile row may be empty, or missing entirely on an
  // older account.
  const profile = await prisma.profile.upsert({
    where: { userId },
    create: { userId, ...profileData },
    update: profileData,
  });

  const roles = user.roles.map((r) => r.role as AppRoleName);
  return publicUser({ ...user, profile }, roles);
};

export const me = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, profile: true, preferences: true },
  });
  if (!user) throw Unauthorized();
  return publicUser(user, user.roles.map((r) => r.role as AppRoleName));
};

/**
 * Start a password reset. Always resolves without revealing whether the email
 * exists (prevents account enumeration). If the account exists and has a
 * password, a single-use, time-limited token is emailed as a reset link.
 */
export const forgotPassword = async (email: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { email } });
  // Silently succeed for unknown accounts, and for any without a password.
  if (!user || !user.passwordHash) return;

  // Invalidate any outstanding tokens for this user, then mint a fresh one.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = crypto.randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
    },
  });

  const resetUrl = `${frontendBaseUrl()}/reset-password?token=${rawToken}`;
  try {
    const mail = passwordResetEmail(resetUrl, user.firstName, RESET_TTL_MINUTES);
    await sendEmail({ to: user.email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (e) {
    logger.error({ err: e, userId: user.id }, "failed to send password reset email");
  }
};

/** Complete a password reset with a valid, unexpired, unused token. */
export const resetPassword = async (token: string, newPassword: string): Promise<void> => {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    throw BadRequest("This reset link is invalid or has expired. Please request a new one.");
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Log the user out of all existing sessions after a reset.
    prisma.refreshToken.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
};

/** Change password for a logged-in user (requires the current password). */
export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) {
    throw BadRequest("Password change is not available for this account.");
  }
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw BadRequest("Your current password is incorrect.");
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
};

const publicUser = (
  u: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    status: string;
    rejectionReason?: string | null;
    profile?: unknown;
  },
  roles: AppRoleName[],
) => ({
  id: u.id,
  email: u.email,
  firstName: u.firstName,
  lastName: u.lastName,
  status: u.status,
  rejectionReason: u.rejectionReason ?? null,
  roles,
  /**
   * Whether the mandatory profile is filled in. The frontend uses this to
   * force an incomplete account through `/complete-profile` before anything
   * else. Callers that didn't load the profile relation get `false`
   * — never silently `true`, so a missing `include` can't open the gate.
   */
  profileComplete: isProfileComplete(u.profile as Parameters<typeof isProfileComplete>[0]),
});