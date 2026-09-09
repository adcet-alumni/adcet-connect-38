/**
 * Admin-tunable application settings.
 *
 * The registry below — not the database — is the source of truth for which
 * settings exist and what they default to. An `AppSetting` row appears only
 * once an admin overrides a default, so a missing row is the normal case and
 * adding a new setting needs no migration or backfill.
 *
 * Every value round-trips through its Zod schema, so a hand-edited or
 * stale row can never hand a service something of the wrong shape: a value
 * that fails to parse is logged and the default is used instead.
 */
import { z } from "zod";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

export const SETTINGS = {
  /**
   * How many feed posts one member may publish per calendar month.
   * Admins are exempt (see `feed.service.ts`).
   */
  feedPostsPerMonth: {
    schema: z.coerce.number().int().min(1).max(1000),
    default: 10,
    label: "Feed posts per member each month",
    description:
      "Members may publish this many posts per calendar month. The allowance resets on the 1st. Admins are not limited.",
  },

  /*
   * Where a donation is actually paid.
   *
   * There is no payment gateway — the college would not carry the fee — so
   * these five values *are* the payment page: the donor reads them, pays in
   * their own bank or UPI app, and comes back to declare what they did. They
   * live here rather than in env because the alumni office changes the account
   * without a deploy, and an admin who mistypes one can fix it the same way.
   *
   * All five default to empty. `GET /donations/payment-details` reports
   * `configured: false` until at least one way to pay is filled in, and the
   * donations page shows "not yet published" instead of an empty QR frame.
   */
  donationUpiId: {
    schema: z.string().trim().max(200),
    default: "",
    label: "UPI ID",
    description:
      "The VPA donors pay to, e.g. adcet@sbi. Shown beside the QR so a donor can type it instead of scanning.",
  },
  donationPayeeName: {
    schema: z.string().trim().max(200),
    default: "",
    label: "Payee name",
    description: "The account name donors will see in their UPI or banking app. Reassures them they are paying the right place.",
  },
  donationQrKey: {
    schema: z.string().trim().max(500),
    default: "",
    label: "Payment QR image",
    description: "The UPI QR code printed on the donations page. Upload a PNG or JPEG of the QR from your bank's app.",
  },
  donationBankDetails: {
    schema: z.string().trim().max(2000),
    default: "",
    label: "Bank transfer details",
    description:
      "Account number, IFSC and branch, for donors who prefer NEFT/IMPS to UPI. One detail per line; shown as typed.",
  },
  donationInstructions: {
    schema: z.string().trim().max(4000),
    default: "",
    label: "Payment instructions",
    description:
      "Anything else a donor should know before paying — shown above the form they fill in afterwards.",
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export const isSettingKey = (key: string): key is SettingKey =>
  Object.prototype.hasOwnProperty.call(SETTINGS, key);

/*
 * A short read-through cache.
 *
 * `getSetting` ran a query every time it was called, including on every feed
 * post — a table of at most a handful of rows, which an admin changes a few
 * times a year, read on a write path. The TTL is deliberately short so a
 * setting changed on one instance takes effect everywhere within seconds
 * without any cross-process coordination; `setSettings` clears the local copy
 * immediately, so the admin who made the change sees it at once.
 *
 * This is per-process state, like the geo and top-donors caches: N instances
 * hold N copies, and the bound on staleness is the TTL rather than the write.
 * That is the whole reason the window is seconds and not minutes.
 */
const CACHE_TTL_MS = 10_000;
let cached: { at: number; values: Record<SettingKey, unknown> } | null = null;

/** Drop the cached copy — called after any write. */
export const invalidateSettings = () => {
  cached = null;
};

const readAll = async (): Promise<Record<SettingKey, unknown>> => {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: SETTING_KEYS } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const values = Object.fromEntries(
    SETTING_KEYS.map((key) => [
      key,
      stored.has(key) ? parseOrDefault(key, stored.get(key)!) : SETTINGS[key].default,
    ]),
  ) as Record<SettingKey, unknown>;
  // Only a successful read is cached, so an outage retries rather than
  // pinning every instance to the defaults for the next ten seconds.
  cached = { at: Date.now(), values };
  return values;
};

/** Read one setting, falling back to its default when unset or unparseable. */
export const getSetting = async <K extends SettingKey>(key: K): Promise<SettingValue<K>> =>
  (await readAll())[key] as SettingValue<K>;

/** Read every setting as a plain object — what the admin settings screen loads. */
export const getAllSettings = (): Promise<Record<SettingKey, unknown>> => readAll();

/**
 * Write settings. Values are validated against the registry first, so an
 * invalid one is rejected before anything is persisted rather than leaving a
 * half-applied update behind.
 */
export const setSettings = async (
  updates: Partial<Record<SettingKey, unknown>>,
  updatedById?: string,
): Promise<Record<SettingKey, unknown>> => {
  const parsed = Object.entries(updates)
    .filter(([key]) => isSettingKey(key))
    .map(([key, value]) => ({
      key: key as SettingKey,
      value: SETTINGS[key as SettingKey].schema.parse(value),
    }));

  await prisma.$transaction(
    parsed.map(({ key, value }) =>
      prisma.appSetting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value), updatedById },
        update: { value: JSON.stringify(value), updatedById },
      }),
    ),
  );
  // Before the read below, so the admin who just saved sees their own change
  // rather than the copy cached a moment earlier.
  invalidateSettings();
  return getAllSettings();
};

const parseOrDefault = <K extends SettingKey>(key: K, raw: string): SettingValue<K> => {
  try {
    return SETTINGS[key].schema.parse(JSON.parse(raw)) as SettingValue<K>;
  } catch (err) {
    logger.error({ err, key, raw }, "[settings] stored value is invalid — using the default");
    return SETTINGS[key].default as SettingValue<K>;
  }
};
