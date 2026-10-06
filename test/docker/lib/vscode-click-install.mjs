#!/usr/bin/env node
// Clicks the "Install" button of VS Code's "MCP Server: <name>" editor (opened by
// the vscode:mcp/install URI handler) through the Chromium DevTools protocol of
// the running VS Code window. This replaces the one human click the install
// flow needs. Usage: node vscode-click-install.mjs <cdp-port> <server-name>
import { createRequire } from "node:module";
const require = createRequire("/opt/driver/");
const { chromium } = require("playwright-core");

const [port = "9229", name = "alza"] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((c) => c.pages());
let page;
for (const p of pages) {
  if (await p.locator(".monaco-workbench").count()) {
    page = p;
    break;
  }
}
if (!page) throw new Error(`no workbench page among ${pages.length} CDP targets`);

const tab = page.locator(".tabs-container .tab", { hasText: `MCP Server: ${name}` });
await tab.first().waitFor({ timeout: 30_000 });
console.log(`found editor tab "MCP Server: ${name}"`);

// The editor header shows the server name and an Install action.
const install = page.getByRole("button", { name: /^Install$/ }).or(page.locator("a.action-label", { hasText: /^Install$/ }));
await install.first().waitFor({ timeout: 30_000 });
await install.first().click();
console.log("clicked Install");

// After installing, the button switches to an installed state (Uninstall / gear / Start...).
const deadline = Date.now() + 30_000;
let state = "unknown";
while (Date.now() < deadline) {
  const labels = await page
    .locator(".editor-instance .action-label, .editor-instance .monaco-button")
    .allInnerTexts()
    .catch(() => []);
  const visible = labels.map((l) => l.trim()).filter(Boolean);
  if (visible.some((l) => /uninstall/i.test(l))) {
    state = `installed (actions now: ${[...new Set(visible)].join(", ")})`;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`post-click state: ${state}`);
await browser.close().catch(() => {});
