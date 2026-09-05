/**
 * Express app composition. Pure wiring — no listening here, no business logic.
 * Easier to import in tests without spinning up a network port.
 */
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { loadOpenApiSpec } from "./config/openapi.js";
import { apiRouter } from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { notFound } from "./middlewares/notFound.js";
import { globalLimiter } from "./middlewares/rateLimit.js";

export const buildApp = () => {
  const app = express();

  app.disable("x-powered-by");
  /*
   * `helmet()` on its own leaves this API without HSTS in the shapes that
   * matter and with a CSP tuned for HTML pages. Two things are set explicitly:
   *
   * - The API's own responses are JSON, plus the Swagger UI page, which needs
   *   inline styles and its own scripts. A blanket default CSP breaks that
   *   page; this one is narrow enough to be worth having and still lets
   *   /api/docs render.
   * - `crossOriginResourcePolicy` is relaxed to cross-origin because the SPA
   *   is served from a different origin and reads files from /uploads under
   *   the local storage driver.
   *
   * The policy protecting *users* is the one on the SPA — see src/lib/csp.ts.
   * A CSP served by the API cannot govern a page the API does not serve.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Swagger UI injects its own styles.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
      // Only meaningful over HTTPS, and only worth committing to in production.
      hsts: env.NODE_ENV === "production"
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(","), credentials: true }));
  // Capture the raw request body so webhook handlers (e.g. Razorpay) can verify
  // HMAC signatures over the exact bytes received.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  if (env.NODE_ENV !== "test") app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  app.use(globalLimiter);

  // Static fallback for the local-disk storage adapter.
  if (env.STORAGE_DRIVER === "local") {
    app.use("/uploads", express.static(env.LOCAL_STORAGE_DIR));
  }

  // OpenAPI / Swagger UI
  try {
    const spec = loadOpenApiSpec();
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec as Record<string, unknown>));
    app.get("/api/openapi.json", (_req, res) => res.json(spec));
  } catch {
    // openapi.yaml not present — skip silently.
  }

  app.use(env.API_PREFIX, apiRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
};