#!/usr/bin/env bash
# DEPLOY A NEW BACKEND — on the server (as ubuntu, no sudo):
#
#   bash ~/Nizan_ERP_CRM/backend/scripts/serverDeploy.sh ~/backend-deploy-YYYYMMDD-HHMM.zip
#   bash ~/Nizan_ERP_CRM/backend/scripts/serverDeploy.sh --rollback      # back to the version before, by hand
#
# What it does, so the site is never left down:
#   1. unpacks the zip next to the live app (backend.next) — the live app keeps running meanwhile;
#   2. copies the server's own .env in;
#   3. packages: reuses the live ones when package-lock.json is unchanged; otherwise STOPS the live app first (npm needs the memory on
#      this small machine) and installs;
#   4. runs the pre-deploy check — if it fails, nothing changes (and a stopped app is started again);
#   5. swaps folders: backend → backend.prev (one previous copy kept), backend.next → backend; starts it with ecosystem.config.cjs;
#   6. health check: the API must answer 401 ("log in first") within 40 s — if not, it switches BACK to the previous version on its
#      own, starts it, and says so;
#   7. pm2 save, so a reboot starts the same version.
# Tools can be swapped for tests: PM2_BIN, NPM_BIN, CURL_BIN, NODE_BIN, APP_PARENT, HEALTH_WAIT, HEALTH_INTERVAL.
set -uo pipefail

APP_PARENT="${APP_PARENT:-$HOME/Nizan_ERP_CRM}"
APP="$APP_PARENT/backend"
NEXT="$APP_PARENT/backend.next"
PREV="$APP_PARENT/backend.prev"
NAME="${PM2_NAME:-nizan-backend}"
PM2="${PM2_BIN:-pm2}"
NPM="${NPM_BIN:-npm}"
CURL="${CURL_BIN:-curl}"
HEALTH_PATH="${HEALTH_PATH:-/api/projects}"
HEALTH_WAIT="${HEALTH_WAIT:-40}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"

say() { echo "▶ $*"; }
ok() { echo "✔ $*"; }
bad() { echo "✖ $*"; }

port_of() {
  local p
  p="$(grep -E '^PORT=' "$1/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' \r")"
  echo "${p:-5000}"
}

is_running() { # does PM2 know a process called $NAME?
  "$PM2" jlist 2>/dev/null | grep -q "\"name\":\"$NAME\""
}

start_app() { # start the app in $APP with its ecosystem file (or the same settings by hand for an older version without one)
  "$PM2" delete "$NAME" >/dev/null 2>&1 || true
  if [ -f "$APP/ecosystem.config.cjs" ]; then
    (cd "$APP" && PM2_NAME="$NAME" "$PM2" start ecosystem.config.cjs >/dev/null 2>&1)
  fi
  # no ecosystem file (an older version), or a PM2 too old to read a .cjs one: the same settings by hand
  if ! is_running; then
    "$PM2" delete "$NAME" >/dev/null 2>&1 || true
    (cd "$APP" && "$PM2" start server.js --name "$NAME" --exp-backoff-restart-delay=2000 \
      --max-memory-restart 450M --node-args="--max-old-space-size=384" >/dev/null)
  fi
}

port_free() { # nothing answers on the API port any more (waits up to 15 s for the stopped app to let go of it)
  local port code end
  port="$(port_of "$APP")"
  end=$((SECONDS + 15))
  while :; do
    code="$("$CURL" -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${port}${HEALTH_PATH}" 2>/dev/null || true)"
    [ -z "$code" ] || [ "$code" = "000" ] && return 0
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}

healthy() { # the API answers 401 (alive, wants a login) within HEALTH_WAIT seconds
  local port code end
  port="$(port_of "$APP")"
  end=$((SECONDS + HEALTH_WAIT))
  while :; do
    code="$("$CURL" -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${port}${HEALTH_PATH}" 2>/dev/null || true)"
    [ "$code" = "401" ] && return 0
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep "$HEALTH_INTERVAL"
  done
}

link_or_copy() { # node_modules into the new folder: hard links (no extra disk) when possible, else a copy
  cp -al "$1" "$2" 2>/dev/null || cp -a "$1" "$2"
}

# ── by hand: back to the previous version ────────────────────────────────────
if [ "${1:-}" = "--rollback" ]; then
  [ -d "$PREV" ] || { bad "There is no previous version ($PREV) to go back to."; exit 1; }
  say "Switching back to the previous version…"
  "$PM2" delete "$NAME" >/dev/null 2>&1 || true
  mv "$APP" "$APP_PARENT/backend.swap" && mv "$PREV" "$APP" && mv "$APP_PARENT/backend.swap" "$PREV"
  start_app
  if healthy; then
    "$PM2" save >/dev/null
    ok "Previous version is running and answering. (The version you left is kept as backend.prev.)"
    exit 0
  fi
  bad "The previous version started but does not answer on /api — look at: pm2 logs $NAME --lines 50"
  exit 1
fi

ZIP="${1:-}"
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "Usage: bash $0 ~/backend-deploy-YYYYMMDD-HHMM.zip   (or --rollback)"; exit 1; }
[ -f "$APP/.env" ] || { bad "No live $APP/.env to copy into the new version — stopping (nothing changed)."; exit 1; }

# the two one-time steps of DEPLOY.md — without them a busy moment can freeze the machine, and a reboot leaves the site down
if command -v swapon >/dev/null 2>&1 && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  echo "⚠ This server has no swap. If packages need installing, the machine may freeze — add it first (DEPLOY.md, one-time step 2)."
fi
if [ -z "${SKIP_BOOT_CHECK:-}" ] && command -v systemctl >/dev/null 2>&1 && ! systemctl is-enabled "pm2-$(id -un)" >/dev/null 2>&1; then
  echo "⚠ PM2 is not set to start at boot: after a reboot the site stays down until someone starts it (DEPLOY.md, one-time step 3)."
fi

# ── 1. unpack next to the live app ───────────────────────────────────────────
say "Unpacking $(basename "$ZIP")…"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q -o "$ZIP" -d "$WORK" || { bad "Could not unzip $ZIP (nothing changed)."; exit 1; }
[ -f "$WORK/backend/server.js" ] || { bad "The zip has no backend/server.js — was it made with scripts/makeDeployZip.sh? (nothing changed)"; exit 1; }
rm -rf "$NEXT"
mv "$WORK/backend" "$NEXT"

# ── 2. the server's own settings ─────────────────────────────────────────────
cp "$APP/.env" "$NEXT/.env"

# ── 3. packages ──────────────────────────────────────────────────────────────
STOPPED=0
restart_live_if_stopped() {
  if [ "$STOPPED" = 1 ]; then
    say "Starting the live version again…"
    "$PM2" start "$NAME" >/dev/null 2>&1 || start_app
  fi
}
if [ -d "$APP/node_modules" ] && cmp -s "$APP/package-lock.json" "$NEXT/package-lock.json"; then
  say "Packages unchanged — reusing the installed ones."
  link_or_copy "$APP/node_modules" "$NEXT/node_modules"
else
  say "Packages changed — stopping the live app to free memory, then installing (a few minutes)…"
  "$PM2" stop "$NAME" >/dev/null 2>&1 || true
  STOPPED=1
  if ! (cd "$NEXT" && "$NPM" ci --omit=dev); then
    bad "Installing the packages failed — the live version stays."
    restart_live_if_stopped
    rm -rf "$NEXT"
    exit 1
  fi
fi

# ── 4. will it start? ────────────────────────────────────────────────────────
say "Checking the new version…"
if ! (cd "$NEXT" && "$NPM" run check); then
  bad "The new version would not start (see above) — the live version stays."
  restart_live_if_stopped
  rm -rf "$NEXT"
  exit 1
fi

# ── 5. swap and start ────────────────────────────────────────────────────────
say "Switching to the new version…"
"$PM2" delete "$NAME" >/dev/null 2>&1 || true
if ! port_free; then
  # another program (a second PM2 app, a 'node server.js' started by hand) holds the port: the new version could not take it, and
  # the health check would be answered by that other program — so do not switch
  bad "Port $(port_of "$APP") is still answered after stopping $NAME — another program is using it, so the new version could not start."
  bad "Nothing switched. See what it is with:  pm2 ls   and   sudo ss -ltnp | grep :$(port_of "$APP")"
  start_app
  rm -rf "$NEXT"
  exit 1
fi
rm -rf "$PREV"
mv "$APP" "$PREV"
mv "$NEXT" "$APP"
start_app

# ── 6. health check (and automatic way back) ─────────────────────────────────
say "Waiting for the API to answer (up to ${HEALTH_WAIT}s)…"
if healthy; then
  "$PM2" save >/dev/null
  ok "Deployed. The API answers. The version before is kept as backend.prev (bash $0 --rollback to go back)."
  exit 0
fi

bad "The new version does not answer — going back to the previous version automatically…"
"$PM2" delete "$NAME" >/dev/null 2>&1 || true
rm -rf "$APP_PARENT/backend.failed"
mv "$APP" "$APP_PARENT/backend.failed"
mv "$PREV" "$APP"
start_app
if healthy; then
  "$PM2" save >/dev/null
  bad "Rolled back: the PREVIOUS version is running again. The failed one is kept as backend.failed — see why with: pm2 logs $NAME --lines 80"
else
  bad "Rolled back, but the previous version does not answer either — look at: pm2 logs $NAME --lines 80"
fi
exit 1
