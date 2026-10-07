#!/usr/bin/env bash
# Bootstrap (idempotent) the Python venv that hosts the Chrome-fingerprint
# transport (scripts/cf-transport.py). Creates .venv-cf/ next to the repo
# root and installs curl_cffi if missing.
#
# Also the manual setup path for installs that never ran postinstall (.mcpb,
# --ignore-scripts, dev checkouts): `bash scripts/ensure-cf-venv.sh`
# (`npm run setup:cf` in a checkout). Needs bash + python3 with the venv module.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-cf"
# Tested range (0.16.3 at time of writing). Widen deliberately after re-testing
# the sidecar; an unpinned install would pull untested major versions into the
# process that handles bearer tokens.
CURL_CFFI_SPEC="curl_cffi>=0.16,<0.17"

if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import curl_cffi" 2>/dev/null; then
  echo "cf-venv: up to date ($VENV)"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "cf-venv: python3 not found — Chrome-fingerprint transport unavailable (browser fallback remains)" >&2
  exit 0
fi

# Remove a venv this run created if anything below fails, so a failed pip does
# not leave a half-built .venv-cf behind. A pre-existing venv is left alone.
CREATED=0
if [ ! -d "$VENV" ]; then CREATED=1; fi
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$CREATED" -eq 1 ]; then
    rm -rf "$VENV"
    echo "cf-venv: setup failed; removed the partial venv ($VENV)" >&2
  fi
}
trap cleanup EXIT

python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet "$CURL_CFFI_SPEC"
"$VENV/bin/python" -c "import curl_cffi"
echo "cf-venv: ready ($VENV, curl_cffi $( "$VENV/bin/python" -c 'import curl_cffi; print(curl_cffi.__version__)'))"
