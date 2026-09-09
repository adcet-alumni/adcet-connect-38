/**
 * Background job runner. Boots no HTTP server — the API is `server.ts`.
 *
 * Jobs used to start inside the web process, which meant every API replica ran
 * every tick. Three replicas sent every alumnus three copies of each event
 * reminder and tripled the request rate at Nominatim, whose policy allows one
 * per second. Splitting them out mirrors the app/server split already in place:
 * `server.ts` serves requests, this serves the clock.
 *
 * Run **one** replica. Every tick still takes a `JobLease` first, so a rolling
 * deploy that briefly overlaps two workers — or an accidental scale-up — skips
 * rather than duplicates.
 */
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { JOB_LEASES, withJobLease, type JobName } from "./lib/jobLease.js";
import { runEventReminders } from "./jobs/eventReminders.js";
import { runGeoBackfill } from "./jobs/geoBackfill.js";
import { runResumeCleanup } from "./jobs/resumeCleanup.js";
import { runDonationPurge } from "./jobs/donationPurge.js";
import { runTokenCleanup } from "./jobs/tokenCleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ScheduledJob {
  name: JobName;
  /** How often to attempt the job. */
  everyMs: number;
  /**
   * How long a claim stays valid. Must exceed the job's worst-case runtime —
   * it is the window in which a process killed mid-run blocks its successor.
   */
  leaseMs: number;
  /** Run once at boot as well as on the interval. */
  runAtStartup: boolean;
  run: () => Promise<unknown>;
}

const JOBS: ScheduledJob[] = [
  {
    name: JOB_LEASES.eventReminders,
    everyMs: DAY_MS,
    // Generous: this one fans out mail, and the lease must outlast the slowest
    // realistic run rather than the typical one.
    leaseMs: 60 * 60_000,
    runAtStartup: true,
    run: runEventReminders,
  },
  {
    name: JOB_LEASES.geoBackfill,
    everyMs: DAY_MS,
    // Nominatim is rate-limited to one request per second, so a backlog of
    // unresolved cities takes real time to work through.
    leaseMs: 2 * 60 * 60_000,
    runAtStartup: false,
    run: runGeoBackfill,
  },
  {
    /*
     * Never started before this — `startResumeCleanupCron` was exported and
     * nothing imported it, so uploaded résumés were retained indefinitely and
     * `resumeDeletedAt` was never set. The job and its tests both passed, which
     * is what made it look wired up.
     */
    name: JOB_LEASES.resumeCleanup,
    everyMs: DAY_MS,
    leaseMs: 30 * 60_000,
    runAtStartup: true,
    run: () => runResumeCleanup(env.RESUME_RETENTION_DAYS),
  },
  {
    /*
     * Rejected donations are archived for a month so the donor has something
     * to point at, then removed. Small and bounded — one indexed read plus a
     * delete per row.
     */
    name: JOB_LEASES.donationPurge,
    everyMs: DAY_MS,
    leaseMs: 30 * 60_000,
    runAtStartup: true,
    run: () => runDonationPurge(),
  },
  {
    /*
     * Three token tables that were only ever written to. Cheap and bounded —
     * deleteMany on indexed predicates — so it runs alongside the rest rather
     * than needing its own cadence.
     */
    name: JOB_LEASES.tokenCleanup,
    everyMs: DAY_MS,
    leaseMs: 15 * 60_000,
    runAtStartup: true,
    run: runTokenCleanup,
  },
];

const tick = (job: ScheduledJob) =>
  withJobLease(job.name, job.leaseMs, job.run)
    .then(({ ran }) => {
      if (!ran) logger.info({ job: job.name }, "skipped — another worker holds the lease");
    })
    .catch((err: unknown) => logger.error({ err, job: job.name }, "job crashed"));

const timers = JOBS.map((job) => {
  if (job.runAtStartup) void tick(job);
  const handle = setInterval(() => void tick(job), job.everyMs);
  return handle;
});

logger.info(
  { jobs: JOBS.map((j) => j.name), resumeRetentionDays: env.RESUME_RETENTION_DAYS },
  "⏰ ADCET Alumni worker started",
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, "worker shutting down...");
  for (const t of timers) clearInterval(t);
  // A job already in flight keeps its lease until it expires. That is the point
  // of the expiry: the next worker takes over rather than waiting on a process
  // that is gone.
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => logger.error({ err }, "unhandledRejection"));
process.on("uncaughtException", (err) => logger.error({ err }, "uncaughtException"));
