#!/usr/bin/env node
// Inspect the running Cursor window over CDP (read-only): which screen it shows,
// which buttons/links exist, and whether an "MCP install" prompt is present.
// Never clicks Log In / Sign Up. Usage: node cursor-probe.mjs <cdp-port>
// Prints one JSON line prefixed with "CURSOR_PROBE ".
import { createRequire } from "node:module";
const require = createRequire("/opt/driver/");
const { chromium } = require("playwright-core");

const port = process.argv[2] ?? "9230";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((c) => c.pages());
const report = { targets: [] };
for (const p of pages) {
  const info = { url: p.url().replace(/\?.*$/, ""), title: await p.title().catch(() => "") };
  info.workbench = (await p.locator(".monaco-workbench").count().catch(() => 0)) > 0;
  info.buttons = [
    ...new Set(
      (await p.locator("button, a, [role=button], .monaco-button").allInnerTexts().catch(() => []))
        .map((t) => t.trim().replace(/\s+/g, " "))
        .filter((t) => t && t.length < 60)
    ),
  ].slice(0, 40);
  const body = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  info.mentionsMcpInstall = /install mcp|mcp server|alza/i.test(body);
  info.textHead = body.slice(0, 300);
  report.targets.push(info);
}
console.log("CURSOR_PROBE " + JSON.stringify(report));
await browser.close().catch(() => {});
