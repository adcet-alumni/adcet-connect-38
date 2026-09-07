/**
 * Central API router. Each module mounts at its versioned path.
 * Adding a new module = one import + one `use(...)`. No business logic here.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { errorMessage } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { getStorage } from "../storage/index.js";
import { authRouter } from "../modules/auth/auth.routes.js";
import { usersRouter } from "../modules/users/users.routes.js";
import { profilesRouter } from "../modules/profiles/profiles.routes.js";
import { eventsRouter } from "../modules/events/events.routes.js";
import { jobsRouter } from "../modules/jobs/jobs.routes.js";
import { achievementsRouter } from "../modules/achievements/achievements.routes.js";
import { donationsRouter } from "../modules/donations/donations.routes.js";
import { alumniRouter } from "../modules/alumni/alumni.routes.js";
import { chaptersRouter } from "../modules/chapters/chapters.routes.js";
import { geoRouter } from "../modules/geo/geo.routes.js";
import { analyticsRouter } from "../modules/analytics/analytics.routes.js";
import { notificationsRouter } from "../modules/notifications/notifications.routes.js";
import { uploadsRouter } from "../modules/uploads/uploads.routes.js";
import { adminRouter } from "../modules/admin/admin.routes.js";
import { contentRouter } from "../modules/content/content.routes.js";
import { galleryRouter } from "../modules/gallery/gallery.routes.js";
import { feedRouter } from "../modules/feed/feed.routes.js";
import { collaborationRouter } from "../modules/collaboration/collaboration.routes.js";

export const apiRouter = Router();

/*
 * Two probes, because orchestrators ask two different questions.
 *
 * There was one endpoint, and it answered `{ status: "ok" }` unconditionally —
 * it returned 200 with Postgres down, so a broken instance kept taking traffic
 * and was never restarted.
 *
 * `/health/live` is "is this process running": if it cannot answer, the
 * process is wedged and should be killed. It must not touch the database — a
 * database outage would then restart every replica, turning an outage into an
 * outage plus a restart storm.
 *
 * `/health/ready` is "can this process serve a request": it checks the
 * dependencies a request actually needs and answers 503 when one is missing,
 * so the instance is taken out of the load balancer without being killed.
 *
 * `/health` stays as it was, for anything already pointed at it.
 */
const liveness = () => ({ status: "ok", uptime: process.uptime() });

apiRouter.get("/health", (_req, res) => res.json(liveness()));
apiRouter.get("/health/live", (_req, res) => res.json(liveness()));

apiRouter.get(
  "/health/ready",
  asyncHandler(async (_req, res) => {
    const checks = await Promise.all([
      probe("database", () => prisma.$queryRaw`SELECT 1`),
      // Reaching storage means resolving the configured driver, not a network
      // round trip: a presign is a local signing operation for S3/MinIO, and a
      // misconfigured driver is the failure this actually catches.
      probe("storage", async () => getStorage().publicUrl("health/probe")),
    ]);

    const ready = checks.every((c) => c.ok);
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unavailable",
      uptime: process.uptime(),
      checks: Object.fromEntries(checks.map((c) => [c.name, c.ok ? "ok" : c.error])),
    });
  }),
);

/** Run one dependency check, turning any failure into a reportable reason. */
const probe = async (name: string, run: () => unknown | Promise<unknown>) => {
  try {
    await run();
    return { name, ok: true as const };
  } catch (err: unknown) {
    logger.warn({ err, check: name }, "readiness check failed");
    return { name, ok: false as const, error: errorMessage(err, "unavailable") };
  }
};

apiRouter.use("/auth", authRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/profiles", profilesRouter);
apiRouter.use("/events", eventsRouter);
apiRouter.use("/jobs", jobsRouter);
apiRouter.use("/achievements", achievementsRouter);
apiRouter.use("/donations", donationsRouter);
apiRouter.use("/alumni", alumniRouter);
apiRouter.use("/chapters", chaptersRouter);
apiRouter.use("/geo", geoRouter);
apiRouter.use("/analytics", analyticsRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/uploads", uploadsRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/content", contentRouter);
apiRouter.use("/gallery", galleryRouter);
apiRouter.use("/feed", feedRouter);
apiRouter.use("/collaboration", collaborationRouter);

// Assistant chatbot — placeholder until a real LLM/agent is wired up.
apiRouter.post("/assistant/chat", (_req, res) =>
  res.json({
    reply: "This feature is not implemented and coming soon.",
    timestamp: new Date().toISOString(),
  }),
);