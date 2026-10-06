#!/usr/bin/env node
// Copies package.json's version into server.json (top-level and packages[0])
// and mcpb/manifest.json. Runs as the npm `version` lifecycle script, so
// `npm version patch` bumps all three in one commit; the release workflow
// refuses to publish when they differ. `--check` only reports a mismatch.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
const version = read("package.json").version;
const check = process.argv.includes("--check");

const server = read("server.json");
const manifest = read("mcpb/manifest.json");
const stale = [];
if (server.version !== version) stale.push(`server.json version ${server.version}`);
if (!server.packages?.[0] || server.packages[0].version !== version) stale.push(`server.json packages[0].version ${server.packages?.[0]?.version}`);
if (manifest.version !== version) stale.push(`mcpb/manifest.json version ${manifest.version}`);

if (check) {
  if (stale.length) {
    console.error(`Mismatch with package.json ${version}: ${stale.join("; ")}`);
    process.exit(1);
  }
  process.exit(0);
}

// Rewrite only the `"version": "..."` values so each file keeps its formatting.
// server.json has exactly two (top level, packages[0]); the manifest has one
// (`manifest_version` does not match the quoted key).
const bump = (file) => {
  const p = path.join(root, file);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/"version":\s*"[^"]*"/g, `"version": "${version}"`));
};
bump("server.json");
bump("mcpb/manifest.json");
console.log(`server.json and mcpb/manifest.json set to ${version}`);
