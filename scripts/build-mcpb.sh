#!/usr/bin/env bash
# Build the Claude Desktop extension bundle (alza-mcp-<version>.mcpb).
# Requires a prior `npm run build`. Output goes to ./build/.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
manifest_version=$(node -p "require('./mcpb/manifest.json').version")
if [ "$version" != "$manifest_version" ]; then
  echo "mcpb/manifest.json version $manifest_version != package.json $version" >&2
  exit 1
fi
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p build
cp -r dist "$stage/dist"
cp mcpb/manifest.json package.json package-lock.json LICENSE README.md "$stage/"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
npx --yes @anthropic-ai/mcpb validate "$stage/manifest.json"
npx --yes @anthropic-ai/mcpb pack "$stage" "build/alza-mcp-$version.mcpb"
echo "built build/alza-mcp-$version.mcpb"
