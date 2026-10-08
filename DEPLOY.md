# Deploying the ADCET Alumni Portal

Sizing, configuration, backup/restore and a load-testing plan for a deployment
serving **12,000 alumni today, growing ~1,600 a year — size for 20,000.**

The headline: **20,000 alumni is a small workload.** The database will be under
a gigabyte for years and the request rate is measured in tens per second, not
thousands. Nothing here needs a cluster. What this document spends its length on
instead are the three places this particular application will fall over first —
email fan-out, bcrypt on login, and object storage growth — because those are
not proportional to "20,000 users" and will not show up in an average-load test.

---

## 1. What runs

Five processes, four of which you can rent:

| Piece | What it is | Notes |
|---|---|---|
| **API** | `node dist/server.js` | Stateless. Run 2+ behind a load balancer. |
| **Worker** | `node dist/worker.js` | **Exactly one.** Every tick takes a `JobLease` first, so an accidental second replica skips rather than duplicates — but it is designed for one. |
| **Postgres** | 16.x | The only stateful piece. |
| **Object storage** | S3 / MinIO / Cloudinary | Avatars, documents, backups. Bytes go browser → storage, never through the API (two exceptions in §6). |
| **SMTP** | any transactional provider | Sizing this is §5. |

The frontend is a static bundle (`npm run build` → `dist/`) served from a CDN or
any static host. It is not a server.

**Do not run the worker inside the API.** It used to be, and every API replica
then ran every cron tick: three replicas sent every alumnus three copies of each
event reminder. `worker.ts` exists to prevent that.

---

## 2. Hardware

### Recommended fleet (20,000 alumni)

| Component | Spec | Why |
|---|---|---|
| API × 2 | 2 vCPU, 2 GB RAM each | One handles peak; two is for deploys and failure, not throughput. See §5.3 — the sizing constraint is bcrypt, not requests. |
| Worker × 1 | 2 vCPU, **4 GB RAM** | RAM is set by the backup job, not the jobs themselves — see the note below. |
| Postgres | 2 vCPU, 4 GB RAM, 20 GB SSD | Working set fits in RAM with room to spare. |
| Object storage | **100 GB**, growing ~15 GB/yr | Dominated by identity documents — §2.2. |
| Load balancer | any | TLS termination, sticky sessions **not** required (JWT, no server session). |

Roughly **6 vCPU and 10 GB of RAM in total.** A single 8 GB VM running everything
under Docker Compose would also work and is a legitimate choice for a college
deployment; the split above buys you zero-downtime deploys.

> **Worker RAM is coupled to backup size.** `jobs/databaseBackup.ts` reads the
> finished dump into a Buffer before uploading, because `StorageService.upload`
> takes a Buffer. Worker RAM must therefore exceed the dump size with headroom.
> At the sizes in §2.1 a dump is ~100–300 MB and 4 GB is generous. If the
> database ever approaches the `UPLOAD_MAX_BYTES.backup` ceiling (2 GB), either
> raise worker RAM or — better — switch to the provider's own snapshots and
> disable this job.

### 2.1 Database size

Measured per-row figures from a development database are meaningless (an
almost-empty table is all 8 KB page overhead), so this is from column widths and
the retention rules the application actually enforces:

| Table group | At 20,000 alumni | Notes |
|---|---|---|
| `User` + `Profile` + roles + preferences | **~40 MB** | ~2 KB per alumnus including the two trigram GIN indexes on names. |
| Feed (`Post`, likes, comments, media) | ~30 MB/yr | Bounded by the posting quota — `feedPostsPerMonth`, default 10. |
| `RefreshToken` | ~20 MB steady state | **Bounded**, not growing: `jobs/tokenCleanup.ts` deletes spent tokens after 30 days. |
| `Notification` | small | Events and jobs fan out **by email only** — they do not write a row per member. This is the single biggest reason the database stays small. |
| `EventRsvp`, `JobApplication` | small | Jobs are deleted at 45 days and take their applications with them. |
| Donations + ledger | small | Thousands of rows a year. |
| `ArchivedContent` | ~200 bytes per purged job/event | The permanent one, by design — it is what keeps the reporting numbers after content is deleted. |

**Plan for 20 GB of disk.** That is roughly twenty times what the data needs, and
the margin is for WAL, autovacuum bloat and the temporary doubling during a
`VACUUM FULL` or a restore.

### 2.2 Object storage — the number that actually matters

| Bucket contents | At 20,000 alumni | |
|---|---|---|
| **Identity documents** | **~30 GB** | 1 per alumnus, ~1.5 MB — a phone photo of a marksheet. **Permanent.** |
| Avatars | ~8 GB | ~400 KB each. |
| Banners | ~4 GB | Fewer members set one. |
| Post media | ~10 GB/yr | The main growth term after the initial import. |
| Gallery | ~5 GB | Admin-managed. |
| Newsletters | ~1 GB | Print-quality PDFs, 25 MB ceiling. |
| Résumés | ~2 GB | **Bounded** — deleted at 180 days, and sooner when their job is purged at 45. |
| Backups | ~3 GB | 12 monthly dumps. |

**Identity documents are now the largest single thing the platform stores, and
they never expire.** That is a deliberate consequence of collecting proof of
study at sign-up — the alumni office needs to be able to re-check an approval —
but it is worth knowing before you pick a storage plan. If 30 GB is a problem,
the lever is `UPLOAD_MAX_BYTES.identity` (currently 10 MB) or client-side
downscaling before upload, not deletion.

### 2.3 When you would need more

Scale the API horizontally (it is stateless) if p95 latency rises under load.
Before adding hardware, check §7 — every known bottleneck in this application is
fixed by a code change, not by a bigger machine.

---

## 3. Configuration

Backend env is validated at boot by `src/config/env.ts`; the process exits if
anything required is missing, so a bad deploy fails immediately rather than at
the first request. `backend/.env.example` is the full list. The ones that matter
in production:

```bash
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://user:pass@host:5432/adcet_alumni?schema=public

# Long, random, and different from each other.
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# Never "*" in production — this is what the browser CORS check enforces.
CORS_ORIGIN=https://alumni.adcet.ac.in

# Prisma reads these from the URL and nowhere else; `lib/prisma.ts` fills them
# in so the same image doesn't open a different number of connections on a
# 2-core container than on an 8-core one.
DATABASE_CONNECTION_LIMIT=10
DATABASE_POOL_TIMEOUT=20
DATABASE_SLOW_QUERY_MS=200      # anything slower is logged — leave this on

STORAGE_DRIVER=s3               # or cloudinary
# ...bucket / credentials per driver

SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
MAIL_FROM="ADCET Alumni <alumni@adcet.ac.in>"

EXPOSE_OTP_ON_MAIL_FAILURE=false   # MUST be false — it returns sign-up OTPs in the API response

# Backups — see §6
DB_BACKUP_ENABLED=true
DB_BACKUP_KEEP=12
```

**Connection budget.** `DATABASE_CONNECTION_LIMIT` is *per process*. Two API
instances plus one worker at 10 each is 30 connections; Postgres defaults to
`max_connections=100`. If you scale the API past six instances, either lower the
limit or put PgBouncer in front.

**Frontend build.** `VITE_API_BASE_URL` and `VITE_STORAGE_PUBLIC_BASE_URL` are
baked in at build time and are also what the generated Content-Security-Policy
names — a build pointed at the wrong API will have a CSP that blocks it.

---

## 4. Deploying

```bash
# Backend
cd backend
npm ci
npx prisma migrate deploy        # never `migrate dev` in production
npx prisma generate
npm run build
node dist/seed-admin.js          # first deploy only — bootstraps the first ADMIN
node dist/server.js              # API  (× N)
node dist/worker.js              # worker (× 1)

# Frontend
npm ci && npm run build          # → dist/, serve statically
```

Migrations are additive and safe to run before the new code is live, with one
exception to know about: `20260909120000_manual_donations_and_drop_oauth` drops
columns. Run migrations during the deploy, not hours ahead of it.

`GET /api/v1/health` checks the database — point the load balancer at it.

**The worker image needs `pg_dump`** (`postgresql-client`, same major version as
the server) if `DB_BACKUP_ENABLED=true`. The API image does not.

---

## 5. Load testing

This is the part worth doing properly, because **average load will tell you
nothing about this application.** It is a portal for a community that is mostly
idle and then entirely non-idle for twenty minutes after the alumni office sends
an email. Test the spike, not the average.

### 5.0 Getting a realistic dataset first

Do not load-test against seed data. Generate 20,000 approved alumni with
plausible department/batch/city spread — the directory's relevance ordering,
the trigram search and the department fan-out all behave differently at scale
than at 21 rows. Write a throwaway script that inserts directly with Prisma
(bypassing bcrypt for the fixtures, then set one known password for the accounts
you will log in as; hashing 20,000 passwords at cost 12 takes about an hour on
its own).

Also generate: ~200 jobs, ~100 events with RSVPs, ~20,000 feed posts, ~5,000
donations. Then `VACUUM ANALYZE` — without fresh statistics the planner will
choose differently than production would.

### 5.1 Scenarios, in the order they will break

Run each in isolation before running them together.

#### A. Event/job notification fan-out — **test this first**

This is the known worst spot in the application, and it is not close.
`events.service.ts` loads **every** matching approved alumnus with no `take`,
signs a JWT per recipient for the in-email RSVP links, and opens one SMTP send
per recipient with `Promise.allSettled` — no concurrency limit, no queue, no
retry — **while the admin's HTTP request is still open.**

At 20,000 recipients that is 20,000 rows in memory, 20,000 signatures on the
event loop, and 20,000 concurrent connections to your SMTP provider.

**Test:** create one event targeting all departments against the 20,000-row
dataset. One request.

**Measure:** wall-clock duration of the POST; peak RSS of the API process;
event-loop lag during it; how many other requests time out while it runs; what
your SMTP provider does (most will rate-limit or drop connections well before
20,000).

**Expect it to fail.** The fix is an `EmailOutbox` table drained by the worker —
`withJobLease` already solves "only one process does this". Until then, the
operational workaround is to send department-targeted notifications rather than
all-department ones, which caps the fan-out at a few thousand.

#### B. Mass login — the CPU wall

Passwords are bcrypt at cost 12: roughly **250–400 ms of pure CPU per login**,
and bcrypt does not yield the event loop.

A 2-vCPU API instance therefore tops out near **5–8 logins/second**, regardless
of how fast everything else is. That is the number to know: 2,000 alumni
clicking an email link within ten minutes is ~3.3 logins/second and fits; the
same 2,000 within two minutes does not.

**Test:** ramp concurrent `POST /auth/login` from 1 → 50 VUs.
**Measure:** throughput plateau, p95, and CPU. The plateau *is* your login
capacity. **Do not lower the bcrypt cost to fix this** — add an instance.

#### C. Mass registration ("user fill latency")

Sign-up is the heaviest write path: an OTP email, a bcrypt hash, a geocode
lookup, an identity-document upload through the API, and the account insert.

**Test separately**, because they fail differently:
1. `POST /auth/register/send-otp` — bound by SMTP, and rate-limited to 20 per 15
   minutes per IP (`RATE_LIMITS.AUTH_MAX`). A college running a registration
   drive from one campus NAT will hit that limit; know it before the day.
2. `POST /auth/register/identity-document` — raw bytes **through the API**, up to
   10 MB each. 100 concurrent uploads is 1 GB in flight. This and
   `/uploads/direct` are the only two paths where file bytes touch the API.
3. `POST /auth/register` — the insert.

**Measure:** p95 per step, API RSS during concurrent uploads, and whether
`resolveProfileLocation` (a gazetteer lookup, in-process) shows up in the slow-query
log.

#### D. Directory browse — the read path everyone uses

`GET /alumni` with search terms, department filters and paging. Relevance
ordering issues one count per band plus a page query.

**Measure:** p95 by page depth (deep pages use OFFSET), and check the slow-query
log for anything not using the trigram or `[department, graduationYear]` indexes.

#### E. Steady-state mixed browse

The realistic day: feed, events, jobs, profile, notifications, in the proportions
you expect. 200–500 VUs.

**Watch specifically:** `requireApproved` does a `findUnique` on **every**
protected request (a known open item). Under load this competes for the
connection pool, and pool exhaustion presents as
`Timed out fetching a new connection from the connection pool` — not as a slow
query. If you see that, raise `DATABASE_CONNECTION_LIMIT` before concluding the
database is the problem.

#### F. Admin analytics

`GET /analytics/admin/insights` runs five grouped raw queries plus aggregates.
One admin, but it is the single most expensive request in the application. Run it
*while* scenario E is running.

### 5.2 What to record, for every scenario

| Layer | Metric | Where |
|---|---|---|
| Client | p50 / p95 / p99, throughput, error rate | k6 summary |
| Node | event-loop lag, RSS, CPU | `--inspect`, or an APM |
| Postgres | active connections, `pg_stat_statements` top 10, cache hit ratio, locks | `pg_stat_activity` |
| App | slow queries | already logged — `DATABASE_SLOW_QUERY_MS=200` |
| Storage/SMTP | error and throttle rates | provider dashboard |

A run that reports latency alone cannot tell you *why*, and every scenario above
fails for a different reason.

### 5.3 Suggested thresholds

These are starting points for a portal, not universal truths:

| Scenario | p95 | Error rate |
|---|---|---|
| Read endpoints (D, E) | < 400 ms | < 0.1% |
| Login (B) | < 1 s | < 0.5% |
| Registration steps (C) | < 2 s | < 1% |
| Admin insights (F) | < 3 s | 0% |
| Notification fan-out (A) | *record it; do not gate on it* | — |

### 5.4 Tooling

k6 fits this best — it is scriptable, has thresholds built in, and its VU model
matches "N alumni browsing". Sketch:

```js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", stages: [
      { duration: "2m", target: 50 },
      { duration: "5m", target: 200 },
      { duration: "2m", target: 0 },
    ]},
  },
  thresholds: {
    "http_req_duration{endpoint:directory}": ["p(95)<400"],
    "http_req_failed{endpoint:directory}": ["rate<0.001"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const h = { headers: { Authorization: `Bearer ${__ENV.TOKEN}` } };
  check(http.get(`${__ENV.API}/alumni?page=1&pageSize=20`, {
    ...h, tags: { endpoint: "directory" },
  }), { "200": (r) => r.status === 200 });
  sleep(Math.random() * 3 + 1);   // real people pause
}
```

Two things to get right or the numbers lie:

- **Disable the rate limiter for the load-test origin, or budget for it.**
  `GLOBAL_MAX` is 300 requests/minute per IP and all your VUs share one. It is
  also **per process**, so with two API instances the effective limit is double —
  a real inconsistency worth knowing.
- **Real browsers generate more load than your script.** TanStack Query still
  runs with `staleTime: 0` and `refetchOnWindowFocus: true`, so every component
  mount and every tab focus refetches. Synthetic load will understate reality;
  either model the refetches or fix that setting first.

### 5.5 Reading the results

Work in this order — later items are invisible until the earlier ones are fixed:

1. **Fan-out (A)** — if this breaks, nothing else matters. Queue it.
2. **Pool exhaustion** — connection-pool timeouts in scenario E. Raise the limit
   or cache `requireApproved`.
3. **Login throughput (B)** — if the plateau is under your expected peak, add an
   API instance. This one really is hardware.
4. **Slow queries** — anything in the log at 200 ms is a missing index; add it
   and re-run rather than adding hardware.
5. **Only then** consider more CPU or RAM.

---

## 6. Backup and restore

Two layers, and you want both:

1. **Your database provider's automated backups** — primary. Point-in-time
   recovery, which nothing in this repository can give you.
2. **`jobs/databaseBackup.ts`** — the portable secondary. One `pg_dump` per
   calendar month into your own object storage, which survives losing the
   provider account entirely.

### How the job behaves

- **Off unless `DB_BACKUP_ENABLED=true`.** A dump is every password hash and
  email address on the platform in one object; it never appears anywhere by
  default.
- **Scheduled daily, acts monthly.** It checks whether the current `YYYY-MM`
  already has a `DatabaseBackup` row and usually does nothing. A fixed 30-day
  interval drifts and resets on restart, and eventually skips a month unnoticed;
  this cannot. A month whose backup failed has no row, so it retries tomorrow.
- **The row is written after the upload**, so a `DatabaseBackup` row always
  means the object is really there.
- **Retention** is `DB_BACKUP_KEEP` (default 12). Older dumps are deleted object
  first, row second.
- **The dump never lingers on disk** — private temp file, removed in a `finally`.

### The bucket must be private

Backups go to the `backup` scope, which the `/uploads` API **cannot name in
either direction** — it is excluded from the request schema, so no admin session
can presign or delete one. That protects the API surface. It does **not** protect
a public-read bucket. Give backups a bucket (or at least a prefix) with its own
restricted credentials and a lifecycle rule, and never the one serving avatars.

### Restoring — the step that is easy to get wrong

Verified against a real dump from this codebase:

```bash
createdb adcet_restore
# THIS LINE MATTERS — see below
psql -d adcet_restore -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
pg_restore --dbname "postgresql://user:pass@host/adcet_restore" \
           --no-owner --no-privileges adcet-2026-09.dump
```

**Create `pg_trgm` before restoring.** The dump does not carry the extension, and
without it `pg_restore` fails to create the five `gin_trgm_ops` indexes — and
*continues anyway*. You get a database that looks complete and correct, with
every row present, in which alumni directory search has silently reverted to
sequential scans. Confirm afterwards:

```sql
SELECT count(*) FROM pg_indexes WHERE indexdef ILIKE '%gin_trgm_ops%';  -- expect 5
```

Two errors are expected and harmless: `schema "public" already exists`, and one
comment on it.

**Object storage is not in the dump.** Avatars, identity documents, résumés and
newsletters live in the bucket; a database restore without the bucket gives you
rows pointing at files that are not there. Version or replicate the bucket
separately.

**Test the restore quarterly.** An untested backup is a hypothesis. The check
above — restore into a scratch database, count the trigram indexes, count `User`
rows — takes five minutes.

---

## 7. Known bottlenecks

Carried from `OPTIMIZATION.md`, in the order a load test will meet them:

| | Impact | Fix |
|---|---|---|
| **Bulk email runs inside the HTTP request** | Breaks first, and hardest. §5.1 A. | `EmailOutbox` table drained by the worker. |
| **`requireApproved` queries per request** | Pool pressure under concurrency. | Cache it, or put `status` in the JWT — both trade away instant revocation, which is a product decision. |
| **TanStack Query `staleTime: 0`** | Real browsers refetch constantly; inflates real load above synthetic. | Set a `staleTime`; changes when data visibly refreshes. |
| **Rate limiter is per-process** | Effective limit multiplies by instance count. | Shared store (Redis). |
| **bcrypt cost 12 on login** | Hard CPU ceiling, ~5–8 logins/s per 2 vCPU. | Add instances. Do not lower the cost. |
| **Backup dump buffered in memory** | Couples worker RAM to database size. | Streaming upload, or the provider's snapshots. |

---

## 8. Pre-production checklist

- [ ] `EXPOSE_OTP_ON_MAIL_FAILURE=false`
- [ ] `CORS_ORIGIN` is the real origin, not `*`
- [ ] JWT secrets are long, random, and not shared with any other environment
- [ ] Exactly **one** worker replica
- [ ] Backup bucket is private, with its own credentials
- [ ] A restore has actually been performed and verified (§6)
- [ ] `pg_dump` in the worker image matches the server's major version
- [ ] `/api/v1/health` wired to the load balancer
- [ ] Postgres `max_connections` > (instances × `DATABASE_CONNECTION_LIMIT`) + worker + headroom
- [ ] First `ADMIN` bootstrapped via `seed-admin`
- [ ] Load test A (fan-out) run, and its result understood before launch day
