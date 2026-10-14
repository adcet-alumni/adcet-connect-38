#!/usr/bin/env bash
#
# run.production.sh — start the whole ADCET Alumni stack in production mode.
#
#   ./run.production.sh              build frontend/backend, apply migrations, start services
#   ./run.production.sh --seed-admin ...and run the seed-admin script first
#   ./run.production.sh --help       this text
#
# This script uses .env.production files in both root and backend directories.
# It assumes Postgres and S3/MinIO are already running (no docker used).
#
# Ctrl-C stops the backend, worker, and frontend.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"

# Ports
API_PORT=4000
WEB_PORT=8080

DO_SEED_ADMIN=0

# ── pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step() { printf "%s==>%s %s\n" "$BLUE$BOLD" "$RESET$BOLD" "$*$RESET"; }
info() { printf "    %s\n" "$DIM$*$RESET"; }
ok()   { printf "    %s✔%s %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "    %s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
die()  { printf "%serror:%s %s\n" "$RED$BOLD" "$RESET" "$*" >&2; exit 1; }

usage() {
  awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
}

# ── args ─────────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --seed-admin) DO_SEED_ADMIN=1 ;;
    -h|--help)    usage ;;
    *)            die "unknown option: $arg (try --help)" ;;
  esac
done

command -v tee >/dev/null || die "tee is not installed"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR" || die "could not create log directory: $LOG_DIR"
LOG_FILE="$LOG_DIR/production-$(date +%Y%m%d-%H%M%S)-$$.log"
exec > >(tee -a "$LOG_FILE") 2>&1
info "writing command-line output to $LOG_FILE"

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

# ── 1. preflight ─────────────────────────────────────────────────────────────
step "Checking prerequisites"
command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"
[ -f "$BACKEND/.env.production" ] || \
  die "backend/.env.production is missing — create it from .env.example with production values"
[ -f "$ROOT/.env.production" ] || warn "root .env.production is missing"
ok "node $(node -v)"

for p in "$API_PORT:backend" "$WEB_PORT:frontend"; do
  if port_busy "${p%%:*}"; then
    die "port ${p%%:*} is already in use (${p##*:}) — stop the other process first"
  fi
done

# ── 2. dependencies ──────────────────────────────────────────────────────────
step "Installing dependencies"
info "frontend: npm ci"
(cd "$ROOT" && npm ci) || die "failed to install frontend dependencies"
ok "frontend dependencies installed"

info "backend: npm ci"
(cd "$BACKEND" && npm ci) || die "failed to install backend dependencies"
ok "backend dependencies installed"

# ── 3. build ─────────────────────────────────────────────────────────────────
step "Building applications"
info "frontend: npm run build"
(cd "$ROOT" && npm run build) || die "frontend build failed"
ok "frontend built successfully"

info "backend: npm run build"
(cd "$BACKEND" && npm run build) || die "backend build failed"
ok "backend built successfully"

# ── 4. database ──────────────────────────────────────────────────────────────
step "Preparing the database"
cd "$BACKEND"
info "generating prisma client"
npx prisma generate --silent
ok "prisma client generated"

info "running database migrations"
npx dotenv -e .env.production -- npx prisma migrate deploy
ok "migrations applied"

if [ "$DO_SEED_ADMIN" -eq 1 ]; then
  info "seeding admin user"
  npx dotenv -e .env.production -- npx tsx prisma/seed-admin.ts
  ok "admin seed complete"
fi
cd "$ROOT"

# ── 5. app processes ─────────────────────────────────────────────────────────
BACKEND_PID=""
WORKER_PID=""
FRONTEND_PID=""

shutdown() {
  trap - INT TERM EXIT
  echo
  step "Shutting down"
  for pid in "$FRONTEND_PID" "$WORKER_PID" "$BACKEND_PID"; do
    [ -n "$pid" ] || continue
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  wait "$FRONTEND_PID" "$WORKER_PID" "$BACKEND_PID" 2>/dev/null || true
  ok "services stopped"
  exit 0
}
trap shutdown INT TERM

step "Starting the apps"

info "starting backend API server on port $API_PORT"
( cd "$BACKEND" && exec setsid npx dotenv -e .env.production -- node dist/server.js ) &
BACKEND_PID=$!

info "starting background worker"
( cd "$BACKEND" && exec setsid npx dotenv -e .env.production -- node dist/worker.js ) &
WORKER_PID=$!

info "starting frontend static server on port $WEB_PORT"
( cd "$ROOT" && exec setsid npm run preview -- --port $WEB_PORT --host ) &
FRONTEND_PID=$!

info "waiting for the API to answer ..."
API_UP=0
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$API_PORT/api/v1/health" >/dev/null 2>&1; then API_UP=1; break; fi
  kill -0 "$BACKEND_PID" 2>/dev/null || break
  sleep 1
done
if [ "$API_UP" -eq 1 ]; then
  ok "api healthy"
else
  warn "api did not answer /api/v1/health yet — check the log above"
fi

cat <<EOF

${BOLD}ADCET Alumni is running in PRODUCTION${RESET}
  ${BOLD}Frontend${RESET}    http://localhost:$WEB_PORT
  ${BOLD}API${RESET}         http://localhost:$API_PORT/api/v1
  ${BOLD}Swagger${RESET}     http://localhost:$API_PORT/api/docs
  ${BOLD}Log file${RESET}    $LOG_FILE
  ${BOLD}Follow logs${RESET}  tail -f "$LOG_FILE"

  ${DIM}Worker process is also running in the background.${RESET}
  ${DIM}Press Ctrl-C to stop.${RESET}

EOF

wait -n "$BACKEND_PID" "$WORKER_PID" "$FRONTEND_PID" 2>/dev/null || true
warn "one of the apps exited"
shutdown
