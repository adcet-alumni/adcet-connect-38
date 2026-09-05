/**
 * A CSP that is too tight breaks payments or the map silently, in production,
 * for one user at a time. These pin the origins the app actually needs, so
 * dropping one is a failing test rather than a support ticket.
 */
import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

const parse = (csp: string) =>
  Object.fromEntries(
    csp.split("; ").map((d) => {
      const [name, ...sources] = d.split(" ");
      return [name, sources];
    }),
  );

const FULL = {
  apiBaseUrl: "https://api.adcet.in/api/v1",
  storageBaseUrl: "https://cdn.adcet.in/adcet-alumni",
  cloudinaryCloudName: "adcet",
};

describe("buildCsp", () => {
  it("allows the API origin to be called, without its path", () => {
    const d = parse(buildCsp(FULL));
    expect(d["connect-src"]).toContain("https://api.adcet.in");
    // A CSP source is an origin; a path would silently never match.
    expect(d["connect-src"].some((s) => s.includes("/api/v1"))).toBe(false);
  });

  it("allows the payment widget to load, call home and open its iframe", () => {
    const d = parse(buildCsp(FULL));
    expect(d["script-src"]).toContain("https://checkout.razorpay.com");
    expect(d["frame-src"]).toContain("https://checkout.razorpay.com");
    expect(d["connect-src"]).toContain("https://api.razorpay.com");
    expect(d["connect-src"]).toContain("https://lumberjack.razorpay.com");
  });

  it("allows map tiles and stored media to be shown", () => {
    const d = parse(buildCsp(FULL));
    expect(d["img-src"]).toContain("https://*.basemaps.cartocdn.com");
    expect(d["img-src"]).toContain("https://cdn.adcet.in");
    expect(d["img-src"]).toContain("https://res.cloudinary.com");
    // Post video needs its own directive; img-src does not cover it.
    expect(d["media-src"]).toContain("https://cdn.adcet.in");
    // Object URLs, for a media preview before upload.
    expect(d["img-src"]).toContain("blob:");
  });

  it("never weakens script-src, which is the directive doing the work", () => {
    const d = parse(buildCsp(FULL));
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
    expect(d["script-src"]).not.toContain("*");
  });

  it("closes the vectors nothing in the app uses", () => {
    const d = parse(buildCsp(FULL));
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
  });

  it("omits an optional origin it was not given rather than widening to a wildcard", () => {
    const d = parse(buildCsp({}));
    expect(d["img-src"]).not.toContain("https://res.cloudinary.com");
    expect(d["img-src"]).not.toContain("*");
  });

  it("falls back to the same API origin the client does, so the two cannot disagree", () => {
    // `api.ts` defaults to http://localhost:4000/api/v1 when VITE_API_BASE_URL
    // is unset. A policy that omitted it would block every request the app
    // makes in exactly the builds that are already misconfigured.
    for (const input of [{}, { apiBaseUrl: "not a url" }]) {
      expect(parse(buildCsp(input))["connect-src"]).toContain("http://localhost:4000");
    }
  });

  it("never emits a source it could not parse", () => {
    // A malformed source invalidates the directive around it in some engines,
    // which fails open or fails everything depending on the browser.
    const d = parse(buildCsp({ apiBaseUrl: "not a url", storageBaseUrl: "also not" }));
    for (const sources of Object.values(d)) {
      for (const s of sources) {
        expect(s).toMatch(/^('[a-z-]+'|[a-z]+:|https?:\/\/[^\s]+)$/);
      }
    }
  });
});
