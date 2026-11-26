#!/usr/bin/env bash
# Put keys into the server's backend .env without pasting them anywhere else, then restart the backend.
#
#   bash ~/scripts/setEnv.sh META_APP_SECRET META_ACCESS_TOKEN
#
# For each key it asks for the value. Secrets (names with SECRET / TOKEN / PASS / KEY / URI / URL in them) are typed
# hidden; ids are shown. Press Enter on its own to keep the current value. Type the word  random  to have a long random
# value made for you (it is shown once, e.g. for META_WEBHOOK_VERIFY_TOKEN, which you then paste into Meta).
#
# The old .env is kept as .env.bak-<date-time> (readable only by you), an existing line for the key is replaced (never
# doubled), the file is made readable only by you, and the backend is restarted and checked.
# Env: ENV_FILE (default ~/Nizan_ERP_CRM/backend/.env), PM2_NAME (default nizan-backend), NO_RESTART=1 to skip the restart.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/Nizan_ERP_CRM/backend/.env}"
NAME="${PM2_NAME:-nizan-backend}"

if [ $# -eq 0 ]; then
  echo "Usage: bash setEnv.sh KEY [KEY ...]   e.g.  bash setEnv.sh META_APP_SECRET META_ACCESS_TOKEN"
  exit 1
fi
[ -f "$ENV_FILE" ] || { echo "✖ No $ENV_FILE"; exit 1; }
for key in "$@"; do
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "✖ \"$key\" is not a key name (capitals, digits and _ only). Nothing changed."; exit 1; }
done

work="$(mktemp)"
trap 'rm -f "$work" "$work.n"' EXIT
cp "$ENV_FILE" "$work"
# a last line without a newline would glue the next key onto it
[ -s "$work" ] && [ "$(tail -c 1 "$work" | od -An -c | tr -d ' ')" != '\n' ] && printf '\n' >> "$work"

changed=0
for key in "$@"; do
  secret=0
  [[ "$key" =~ SECRET|TOKEN|PASS|KEY|URI|URL ]] && secret=1
  had=""
  grep -qE "^${key}=." "$work" && had=" (has a value now — Enter keeps it)"
  if [ $secret -eq 1 ]; then
    read -rsp "$key, hidden$had: " val; echo
  else
    read -rp "$key$had: " val
  fi
  if [ -z "$val" ]; then echo "  $key unchanged"; continue; fi
  if [ "$val" = "random" ]; then
    val="$(openssl rand -hex 24)"
    echo "  $key = $val   ← made for you; copy it now (it is not shown again)"
  fi
  case "$val" in *$'\n'*|*$'\r'*) echo "✖ The value has a line break. Nothing changed."; exit 1 ;; esac
  # plain values as they are; anything with spaces, # or quotes in single quotes (dotenv reads both)
  if [[ "$val" =~ ^[A-Za-z0-9._:/@%+=?\&,~-]+$ ]]; then
    line="${key}=${val}"
  elif [[ "$val" != *"'"* ]]; then
    line="${key}='${val}'"
  else
    echo "✖ The value for $key has a ' in it; put that one in by hand. Nothing changed."; exit 1
  fi
  grep -vE "^${key}=" "$work" > "$work.n" || true
  mv "$work.n" "$work"
  printf '%s\n' "$line" >> "$work"
  echo "  $key set (${#val} characters)"
  changed=1
done

if [ $changed -eq 0 ]; then echo "Nothing to change."; exit 0; fi

backup="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$backup"
chmod 600 "$backup"
cat "$work" > "$ENV_FILE"   # same file, same owner
chmod 600 "$ENV_FILE"
echo "✔ Saved $ENV_FILE (the old one is $backup)"

[ "${NO_RESTART:-}" = "1" ] && exit 0

PM2="$(command -v pm2 || true)"
[ -n "$PM2" ] || { echo "⚠ pm2 not found — restart the backend yourself"; exit 0; }
"$PM2" restart "$NAME" --update-env >/dev/null && echo "↻ Restarted $NAME"
PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d "\r\"' ")"
PORT="${PORT:-5000}"
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/projects" || true)"
  if [ "$code" = "401" ]; then echo "✔ The API answers again (port $PORT)"; exit 0; fi
  sleep 2
done
echo "✖ The API did not answer within 40 s. Look at: pm2 logs $NAME --lines 60"
echo "  To undo: cp \"$backup\" \"$ENV_FILE\" && pm2 restart $NAME --update-env"
exit 1
