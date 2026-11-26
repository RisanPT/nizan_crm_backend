#!/usr/bin/env bash
# MAKE THE DEPLOY ZIP — on the Mac, from anywhere:
#
#   bash scripts/makeDeployZip.sh
#
# 1. Runs the pre-deploy check (scripts/predeployCheck.mjs): nothing is zipped if the backend would not start.
# 2. Builds ~/Downloads/backend-deploy-<date-time>.zip with ONLY what the server runs (top folder: backend/, as before).
#    Never in it: .env files (the server keeps its own), node_modules (the server installs its own), tmp/ (customer CSVs), tests/,
#    .git, .DS_Store, CSV files, stray scripts at the root.
# Upload the zip to the server's home folder, then follow DEPLOY.md.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT_DIR="${DEPLOY_ZIP_DIR:-$HOME/Downloads}"
ZIP="$OUT_DIR/backend-deploy-$(date +%Y%m%d-%H%M).zip"

echo "1/2  Checking that the backend starts…"
if ! node scripts/predeployCheck.mjs; then
  echo "Not zipped: fix the problems above first."
  exit 1
fi

echo "2/2  Building the zip…"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/backend"
mkdir -p "$STAGE"

# what the server needs to run (files and folders at the backend root)
INCLUDE=(server.js package.json package-lock.json ecosystem.config.cjs DEPLOY.md
         config controllers middleware models routes services utils data assets fixtures scripts)
for item in "${INCLUDE[@]}"; do
  if [ -e "$item" ]; then
    rsync -a \
      --exclude '.DS_Store' --exclude '*.csv' --exclude '*.py' --exclude '*.txt' \
      --exclude '.env*' --exclude 'node_modules' \
      "$item" "$STAGE/"
  else
    echo "  (no $item — skipped)"
  fi
done

mkdir -p "$OUT_DIR"
(cd "$WORK" && zip -qr "$ZIP" backend)

# a last look: nothing secret or personal went in
if unzip -Z1 "$ZIP" | grep -Eq '(^|/)\.env|node_modules/|(^|/)tmp/|(^|/)tests/|\.csv$|\.DS_Store'; then
  echo "✖ Something that must not leave this Mac is in the zip:"
  unzip -Z1 "$ZIP" | grep -E '(^|/)\.env|node_modules/|(^|/)tmp/|(^|/)tests/|\.csv$|\.DS_Store' | head
  rm -f "$ZIP"
  exit 1
fi

FILES="$(unzip -Z1 "$ZIP" | grep -vc '/$')"
SIZE="$(du -h "$ZIP" | cut -f1)"
echo
echo "✔ $ZIP"
echo "  $FILES files, $SIZE — no .env, no node_modules, no tmp/ or tests/."
echo
echo "Next: upload it to the server's home folder (/home/ubuntu), then on the server:"
echo "  bash ~/Nizan_ERP_CRM/backend/scripts/serverDeploy.sh ~/$(basename "$ZIP")"
