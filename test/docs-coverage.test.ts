import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

process.env.ALZA_TOKEN_FILE = "none";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(path.join(root, "docs", "mobile-endpoint-coverage.md"), "utf8");
const header = (l: string) => {
  const id = l.split("|")[1]!.trim();
  return id === "#" || /^-+$/.test(id);
};
const rows = doc.split("\n").filter((l) => /^\| [A-Za-z0-9-]+ \|/.test(l) && !header(l) && l.split(" | ").length >= 10);

/** AGENTS.md: only these verification labels are allowed. */
const LABELS = ["source-confirmed", "live-verified", "blocked", "unresolved"];
const statusOf = (row: string) => row.split(" | ").at(-1)!;
const idOf = (row: string) => row.split("|")[1]!.trim();

async function allToolNames(): Promise<string[]> {
  const built = buildServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "docs-coverage-test", version: "0" });
  await built.server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({ name: "set_toolset", arguments: { id: "all", enabled: true } });
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
    await built.close();
  }
}

describe("docs/mobile-endpoint-coverage.md", () => {
  it("has a matrix row naming every registered tool", async () => {
    const names = await allToolNames();
    expect(names.length).toBeGreaterThan(60);
    const missing = names.filter((n) => !rows.some((r) => r.includes(`\`${n}\``)));
    expect(missing, `tools without a matrix row (method, route, inputs, response, prerequisites, side effects, label): ${missing.join(", ")}`).toEqual([]);
  });

  it("uses unique row ids and only the four allowed status labels", () => {
    const ids = rows.map(idOf);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(rows.filter((r) => !LABELS.some((l) => statusOf(r).includes(`\`${l}\``))).map(idOf)).toEqual([]);
  });

  it("dates every live-verified row", () => {
    const undated = rows.filter((r) => statusOf(r).includes("`live-verified`") && !/20\d\d-\d\d-\d\d/.test(statusOf(r)));
    expect(undated.map(idOf)).toEqual([]);
  });
});
