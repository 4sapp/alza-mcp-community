// Probe the alza MCP server over stdio exactly as the pi agent would:
// spawn the registered command, initialize, list tools, run the requested
// tool calls, and merge every response into the dated evidence capture.
// Usage: node scripts/.pi-mcp-probe.mjs --section registration \
//   --call '{"name":"alza_account_status","arguments":{}}' [--call ...]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverCmd = process.env.ALZA_MCP_CMD ?? "node";
const serverArgs = (process.env.ALZA_MCP_ARGS ?? `${repo}/dist/index.js`).split(" ");
const capture = process.env.PI_CAPTURE ?? "docs/live-evidence/pi-integration-2026-09-10.json";

const argv = process.argv.slice(2);
const section = (() => { const i = argv.indexOf("--section"); return i >= 0 ? argv[i + 1] : "probe"; })();
const calls = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--call") calls.push(JSON.parse(argv[i + 1]));
}

const child = spawn(serverCmd, serverArgs, { stdio: ["pipe", "pipe", "pipe"] });
const lines = [];
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) if (line.trim()) lines.push(line);
});
let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString(); });

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const nextId = ((() => { let n = 0; return () => ++n; })());
async function request(method, params) {
  const id = nextId();
  send({ jsonrpc: "2.0", id, method, params });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const found = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((m) => m && m.id === id);
    if (found) {
      if (found.error) return { error: found.error };
      return { result: found.result };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { error: { code: -1, message: `timeout waiting for ${method}` } };
}

const record = { server: { command: serverCmd, args: serverArgs }, startedAt: new Date().toISOString() };
try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-integration-probe", version: "1.0.0" },
  });
  record.initialize = init;
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request("tools/list", {});
  record.toolNames = list.result?.tools?.map((t) => t.name) ?? [];
  record.toolCount = record.toolNames.length;
  record.toolSummaries = (list.result?.tools ?? []).map((t) => ({ name: t.name, description: t.description?.slice(0, 160) }));

  record.calls = [];
  for (const call of calls) {
    const res = await request("tools/call", { name: call.name, arguments: call.arguments ?? {} });
    const entry = { name: call.name, arguments: call.arguments ?? {} };
    if (res.error) entry.error = res.error;
    else {
      const content = res.result?.content ?? [];
      entry.isError = res.result?.isError === true;
      entry.contentText = content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
      if (res.result?.structuredContent) entry.structuredContent = res.result.structuredContent;
    }
    record.calls.push(entry);
  }
} catch (e) {
  record.fatal = String(e && e.stack || e);
} finally {
  child.kill();
  record.stderrTail = stderr.slice(-2000);
}
record.finishedAt = new Date().toISOString();

const abs = path.join(repo, capture);
const doc = existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) : { capture: path.basename(capture) };
doc[section] = record;
writeFileSync(abs, JSON.stringify(doc, null, 2));
console.log(JSON.stringify({
  ok: !record.fatal && !record.initialize?.error,
  protocolVersion: record.initialize?.result?.protocolVersion,
  serverInfo: record.initialize?.result?.serverInfo,
  toolCount: record.toolCount,
  calls: (record.calls ?? []).map((c) => ({ name: c.name, isError: c.isError ?? !!c.error, textHead: (c.contentText ?? JSON.stringify(c.error)).slice(0, 300) })),
  fatal: record.fatal,
}, null, 2));
