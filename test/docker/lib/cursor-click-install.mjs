#!/usr/bin/env node
// Cursor: read the "Install MCP server?" dialog that the cursor://…/mcp/install
// deeplink opens (fields: Name, Type, Command, Arguments, Secrets), print what it
// shows, then click its "Install" button — the one human click in the flow.
// Never touches Log In / Sign Up. Usage: node cursor-click-install.mjs <cdp-port>
// Prints "CURSOR_DIALOG <json>" with the fields as displayed.
import { createRequire } from "node:module";
const require = createRequire("/opt/driver/");
const { chromium } = require("playwright-core");

const port = process.argv[2] ?? "9230";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

// Smallest element that contains both the dialog title and an "Install" button.
const findDialog = () => {
  const all = [...document.querySelectorAll("body *")];
  const title = all.find((e) => e.childElementCount === 0 && e.textContent.trim() === "Install MCP server?");
  if (!title) return null;
  let box = title.parentElement;
  const isInstall = (b) => b.textContent.trim() === "Install";
  while (box && ![...box.querySelectorAll("button, [role=button], .monaco-button, a, div, span")].some((b) => b.childElementCount === 0 && isInstall(b))) {
    box = box.parentElement;
  }
  if (!box) return null;
  box.setAttribute("data-harness-dialog", "1");
  const inputs = [...box.querySelectorAll("input, textarea")].map((e) => ({ placeholder: e.getAttribute("placeholder") ?? "", value: e.value }));
  const pressed = [...box.querySelectorAll("[aria-pressed=true], [aria-selected=true], [aria-checked=true], [data-state=on], [data-selected=true]")].map((e) => e.textContent.trim());
  return { inputs, pressed, text: box.innerText.replace(/\s+/g, " ").slice(0, 400) };
};

const deadline = Date.now() + 30_000;
let page;
let info;
while (!info && Date.now() < deadline) {
  for (const p of browser.contexts().flatMap((c) => c.pages())) {
    info = await p.evaluate(findDialog).catch(() => null);
    if (info) {
      page = p;
      break;
    }
  }
  if (!info) await new Promise((r) => setTimeout(r, 500));
}
if (!info) {
  console.error("no 'Install MCP server?' dialog found in any Cursor window");
  process.exit(1);
}
console.log("CURSOR_DIALOG " + JSON.stringify({ window: await page.title(), ...info }));

const dialog = page.locator("[data-harness-dialog]");
const install = dialog.locator("button, [role=button], .monaco-button, a, div, span").filter({ hasText: /^Install$/ });
await install.last().click();
console.log("clicked Install");
await new Promise((r) => setTimeout(r, 2500));
await browser.close().catch(() => {});
