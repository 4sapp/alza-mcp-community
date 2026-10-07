import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { AlzaRejectedError } from "../src/infra/errors.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { formatOrder } from "../src/tools/account-format.js";
import { createAccountTools } from "../src/tools/account.js";
import { createAdvancedTools } from "../src/tools/advanced.js";
import { createWatchdogTools } from "../src/tools/watchdog.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

/**
 * Issue #79: typed reads report Alza's err:1 envelopes as tool errors. Everything is
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


describe("#79 err:1 envelopes are errors on the typed reads", () => {
  it("after_order_payments reports err:1 as isError with Alza's message", async () => {
    installFetch(() => json({ err: 1, msg: "Objednávka se zadaným ID neexistuje", data: null }));
    const client = await connect();
    const res = await client.callTool({ name: "after_order_payments", arguments: { order_id: "999999999", part_id: "1" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Objednávka se zadaným ID neexistuje");
    await expect(makeAccount().afterOrderPayments("999999999", "1")).rejects.toBeInstanceOf(AlzaRejectedError);
  });

  it("keeps mobile_read's documented raw-envelope contract for the same route", async () => {
    installFetch(() => json({ err: 1, msg: "nope" }));
    const client = await connect();
    const res = await client.callTool({ name: "mobile_read", arguments: { operation: "after_order_payments", args: { order_id: "9", part_id: "1" } } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ err: 1, msg: "nope" });
  });

  it("order reports a nested {order: {err: 1}} as isError, and formatOrder shows it", async () => {
    installFetch(() => json({ err: 1, msg: "Order not found" }));
    const client = await connect();
    const res = await client.callTool({ name: "order", arguments: { order_id: "1", user_id: UID } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Order not found");
    expect(formatOrder({ order: { err: 1, msg: "Order not found" } })).toContain("Alza rejected the read (err:1): Order not found");
  });
});
