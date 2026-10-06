#!/usr/bin/env bash
# Records a real Claude Code session against alza.cz (catalog tools only) as stream-json.
# Usage: scripts/record-demo-session.sh <out.jsonl>   (run `npm run build` first)
set -euo pipefail
OUT="${1:?usage: record-demo-session.sh <out.jsonl>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$(mktemp)"
trap 'rm -f "$CFG"' EXIT
CF=""
[ -n "${ALZA_CF_PYTHON:-}" ] && CF=",\"ALZA_CF_PYTHON\":\"$ALZA_CF_PYTHON\""
cat > "$CFG" <<EOF
{"mcpServers":{"alza":{"command":"node","args":["$ROOT/dist/index.js"],"env":{"ALZA_TOKEN_FILE":"none"$CF}}}}
EOF
PROMPT='Find me the best pro-grade wheel cleaner under 600 Kč and tell me where I can pick it up in Prague. Use only the alza tools. Be brief.'
claude -p "$PROMPT" \
  --mcp-config "$CFG" --strict-mcp-config \
  --allowedTools "mcp__alza__search_products mcp__alza__get_product mcp__alza__find_pickup_points" \
  --disallowedTools "Bash Read Write Edit WebFetch WebSearch" \
  --model sonnet --output-format stream-json --verbose --permission-mode dontAsk > "$OUT"
