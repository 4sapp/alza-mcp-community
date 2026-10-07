import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { createAccountTools } from "../src/tools/account.js";
import { createAdvancedTools } from "../src/tools/advanced.js";
import { createWatchdogTools } from "../src/tools/watchdog.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

/**
 * Issue #79: mobile_read checks each operation's required arguments before sending. Everything is
 * offline: fetch is a recording mock, the account is never signed in, and no
 * request leaves the process.
 */
process.env.ALZA_TOKEN_FILE = "none";

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
  vi.useRealTimers();
});

type Route = (url: string, method: string) => Response | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** Records every request; `route` answers it (default: 200 `{err: 0}`). */
function installFetch(route: Route = () => undefined): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    return route(url, method) ?? json({ err: 0 });
  }) as typeof fetch;
  return calls;
}

const makeAccount = () => new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }));
const UID = "100000001";
const OTHER_UID = "100000002";

async function connect(account = makeAccount()): Promise<Client> {
  const deps = { mobileAccount: account } as unknown as ToolDeps;
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  const wrap = async (_name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try { return await fn(); } catch (err) { return { content: [{ type: "text", text: String(err) }], isError: true }; }
  };
  for (const tool of [...createAccountTools(deps), ...createAdvancedTools(deps), ...createWatchdogTools(deps)]) tool.register(server, wrap);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (res: Awaited<ReturnType<Client["callTool"]>>) => (res.content as Array<{ text: string }>).map((c) => c.text).join("\n");


describe("#79 mobile_read validates required args per operation", () => {
  it("refuses user_navigation without user_id before any request", async () => {
    const calls = installFetch();
    const client = await connect();
    const res = await client.callTool({ name: "mobile_read", arguments: { operation: "user_navigation" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/user_navigation: user_id is required/);
    expect(calls).toEqual([]);
  });

  it("refuses quick_order_summary without ucik/pgrik and NaN product ids", async () => {
    const calls = installFetch();
    const account = makeAccount();
    await expect(account.read("quick_order_summary", { user_id: UID, commodity_id: 7229946 })).rejects.toThrow(/pgrik is required[\s\S]*ucik is required|ucik is required[\s\S]*pgrik is required/);
    await expect(account.read("router_product", { product_id: "abc" })).rejects.toThrow(/product_id must be a positive integer/);
    await expect(account.read("legacy_product", {})).rejects.toThrow(/product_id is required/);
    await expect(account.read("premium_trial", { user_id: "" })).rejects.toThrow(/user_id/);
    await expect(account.read("branches", { latitude: 50 })).rejects.toThrow(/longitude is required/);
    expect(calls).toEqual([]);
  });

  it("still sends valid reads unchanged (numeric strings accepted as before)", async () => {
    const calls = installFetch();
    const account = makeAccount();
    await account.read("quick_order_summary", { user_id: UID, commodity_id: "7229946", pgrik: "p__1", ucik: "u__2" });
    await account.read("router_product", { product_id: 13078770 });
    await account.read("user_navigation", { user_id: Number(UID) });
    await account.read("branches", { latitude: "50.08", longitude: "14.42" });
    expect(calls).toEqual([
      `GET https://test.alza.invalid/api/users/${UID}/v1/quickOrder/summary/commodities/7229946?pgrik=p__1&ucik=u__2`,
      "GET https://test.alza.invalid/api/router/legacy/catalog/product/13078770",
      `GET https://webapi.alza.cz/api/users/${UID}/mainNavigation?country=CZ`,
      "GET https://test.alza.invalid/api/branches/v1/cityBranches?latitude=50.08&longitude=14.42",
    ]);
  });
});
