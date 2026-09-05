/**
 * The Content-Security-Policy for the single-page app.
 *
 * Build-time only — `vite.config.ts` imports this and injects the result as a
 * `<meta http-equiv>` into `index.html`. Nothing in the running application
 * imports it.
 *
 * **Why it exists.** Auth tokens live in `localStorage` (see `api.ts`), which
 * any script on the origin can read, so an XSS becomes a full account takeover
 * with a seven-day refresh token as the prize. Keeping tokens there is a
 * deliberate trade; a CSP is the compensating control that makes injected
 * script fail to load and fail to exfiltrate.
 *
 * **Why it is generated rather than a static file.** The API and object storage
 * live on origins that differ per deployment and are only known from
 * `VITE_API_BASE_URL` / `VITE_STORAGE_PUBLIC_BASE_URL`. A hand-written policy
 * would either omit them — breaking every request the moment it shipped — or
 * be widened to `*` until it stopped meaning anything.
 *
 * **What each third party is for.** Every entry below is reachable from code in
 * this repository; nothing is here speculatively:
 * - `checkout.razorpay.com` — the payment widget's script and its iframe
 *   (`DonationsPage`), plus `api.razorpay.com` and `lumberjack.razorpay.com`,
 *   which it calls itself.
 * - `*.basemaps.cartocdn.com` — the map tiles in `AlumniMap`.
 * - the storage origin — avatars, post media, gallery photos, newsletters.
 */

/** Just the scheme and host of a URL — a CSP source never carries a path. */
const originOf = (url?: string): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export interface CspInput {
  /** `VITE_API_BASE_URL`, e.g. https://api.adcet.in/api/v1 */
  apiBaseUrl?: string;
  /** `VITE_STORAGE_PUBLIC_BASE_URL`, e.g. https://cdn.adcet.in/adcet-alumni */
  storageBaseUrl?: string;
  /** Set when STORAGE_DRIVER=cloudinary, which serves from res.cloudinary.com. */
  cloudinaryCloudName?: string;
}

/**
 * The same fallback `api.ts` applies when `VITE_API_BASE_URL` is unset.
 *
 * The two must agree: a policy that omits the origin the client will actually
 * call blocks every request in the app, and a build with no API URL set is
 * already pointed at localhost — better that the CSP say so than that it
 * silently disagree with the code.
 */
const DEFAULT_API_BASE_URL = "http://localhost:4000/api/v1";

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com";
const RAZORPAY_API = ["https://api.razorpay.com", "https://lumberjack.razorpay.com"];
const CARTO_TILES = "https://*.basemaps.cartocdn.com";
const CLOUDINARY = "https://res.cloudinary.com";

export const buildCsp = (input: CspInput): string => {
  const api = originOf(input.apiBaseUrl) ?? originOf(DEFAULT_API_BASE_URL);
  const storage = originOf(input.storageBaseUrl);
  const cloudinary = input.cloudinaryCloudName ? CLOUDINARY : null;

  const media = [storage, cloudinary].filter(Boolean) as string[];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    /*
     * No 'unsafe-eval' and no 'unsafe-inline' here — that is the directive
     * doing the actual work, and Vite emits only external module scripts, so
     * nothing in the app needs either.
     */
    "script-src": ["'self'", RAZORPAY_SCRIPT],
    /*
     * 'unsafe-inline' is unavoidable for styles: Tailwind is fine, but Leaflet
     * positions every tile and marker with an inline `style` attribute, and
     * Radix does the same for popovers. Inline *style* cannot execute script,
     * so this is a far weaker concession than the script equivalent.
     */
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", CARTO_TILES, ...media],
    "media-src": ["'self'", "blob:", ...media],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(api ? [api] : []), ...media, ...RAZORPAY_API],
    "frame-src": [RAZORPAY_SCRIPT, "https://api.razorpay.com"],
    // Nothing in the app embeds a plugin, opens a base tag, or posts a form
    // anywhere but its own API — so say so, and close those vectors.
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    // `frame-ancestors` is ignored when a policy arrives in a meta tag, so it
    // is set as a real header instead — see `public/_headers`.
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(" ")}`)
    .join("; ");
};
