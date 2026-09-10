/**
 * Proof of study, collected at sign-up.
 *
 * Nothing on an account previously said whether the applicant had actually
 * been a student at ADCET — an admin approving one had a name, a batch and a
 * department, every one of them typed by the applicant. Sign-up now asks for a
 * document, and the admin reviewing the account is shown it.
 *
 * Deliberately import-free so the backend's `tests/lib/identity.test.ts` can
 * load it and fail the build when either list drifts from
 * `config/constants.ts`.
 */

/** Mirrors `IDENTITY_DOCUMENT_KINDS` in the backend's `config/constants.ts`. */
export const IDENTITY_DOCUMENT_KINDS = [
  "Library card",
  "Marksheet",
  "Leaving certificate",
  "Degree certificate",
] as const;

/** Mirrors `IDENTITY_DOCUMENT_MIME_TYPES`. The server checks the bytes it receives. */
export const IDENTITY_DOCUMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

/** What the file picker offers, and what the server will accept. */
export const IDENTITY_ACCEPT = IDENTITY_DOCUMENT_MIME_TYPES.join(",");

/** Reads as "Library card, marksheet, leaving certificate or degree certificate". */
export const identityDocumentList = (): string => {
  const [first, ...rest] = IDENTITY_DOCUMENT_KINDS;
  const lower = rest.map((k) => k.toLowerCase());
  const last = lower.pop();
  return `${first}, ${lower.join(", ")} or ${last}`;
};
