#!/usr/bin/env bash
# Live canary from a machine with a home/office IP.
#
# GitHub-hosted runners are challenged by Alza's Cloudflare whatever client they use
# (see .github/workflows/live-canary.yml and docs/gap-analysis.md), so the scheduled
# workflow can only report the block. This script runs the same read-only checks
# (scripts/validate-api.ts) where Cloudflare lets us through, and reports exactly like the
# workflow: a failing run opens (or comments on) one `canary` issue; a passing run
# comments on and closes that issue; a Cloudflare challenge changes nothing.
#
# It works in its own clone, never in your working tree. Needs: git, node >= 20, npm, python3
# (for the optional curl_cffi sidecar), and an authenticated GitHub CLI (`gh auth status`).
#
#   scripts/local-canary.sh                # run now
#   CANARY_DRY_RUN=1 scripts/local-canary.sh   # run the checks, don't touch GitHub
#
# Env: CANARY_REPO (default lukabudik/alza-mcp-community), CANARY_DIR (default ~/.cache/alza-mcp-canary),
#      CANARY_REF (default main).
# Schedule it with a systemd user timer or cron; see docs/live-canary-local.md.
set -euo pipefail

REPO_SLUG="${CANARY_REPO:-lukabudik/alza-mcp-community}"
DIR="${CANARY_DIR:-$HOME/.cache/alza-mcp-canary}"
REF="${CANARY_REF:-main}"
DRY="${CANARY_DRY_RUN:-0}"
export ALZA_TOKEN_FILE=none   # the canary is anonymous; never read a real account's tokens

mkdir -p "$DIR"
cd "$DIR"
if [ ! -d repo/.git ]; then
  git clone --quiet "https://github.com/$REPO_SLUG.git" repo
fi
cd repo
git fetch --quiet origin "$REF"
git reset --quiet --hard "origin/$REF"
git clean --quiet -fdx -e node_modules -e .venv-cf
npm ci --silent --no-audit --no-fund
bash scripts/ensure-cf-venv.sh >/dev/null 2>&1 || true   # optional sidecar; the checks fall back without it

md="$DIR/canary.md"; log="$DIR/canary.log"
rm -f "$md"
set +e
npm run validate:api -- --markdown "$md" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ ! -s "$md" ]; then
  { echo "### ❌ Local live canary crashed (exit $code)"; echo; echo '```'; tail -n 40 "$log"; echo '```'; } > "$md"
fi
{ echo; echo "Run: local canary on $(hostname -s), $(date -u +%FT%TZ), commit $(git rev-parse --short HEAD)"; } >> "$md"

if [ "$DRY" = "1" ]; then
  echo "[dry run] exit code $code; summary:"; cat "$md"; exit 0
fi

export GH_REPO="$REPO_SLUG"
existing=$(gh issue list --label canary --state open --limit 1 --json number --jq '.[0].number // empty')
case "$code" in
  0)
    if [ -n "$existing" ]; then
      gh issue comment "$existing" --body-file "$md"
      gh issue close "$existing" --reason completed --comment "The canary passes again."
    fi
    ;;
  2)
    echo "Cloudflare challenged this machine as well; no verdict on the selectors. Nothing filed."
    ;;
  *)
    gh label create canary --color B60205 --description "Live canary against alza.cz is failing" 2>/dev/null || true
    if [ -n "$existing" ]; then
      gh issue comment "$existing" --body-file "$md"
    else
      gh issue create --title "Live canary failing: $(date -u +%Y-%m-%d)" --label canary --body-file "$md"
    fi
    exit 1
    ;;
esac
