import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MUTATION_PAYLOAD_DEFAULTS, MUTATION_TOKEN_TTL_MS, MobileAccount } from "../src/domain/mobile-account.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { createAccountTools } from "../src/tools/account.js";
import { createAdvancedTools } from "../src/tools/advanced.js";
import { createWatchdogTools } from "../src/tools/watchdog.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

/**
 * Issue #79: confirmation tokens are bound to the payload, expire after 5 minutes, and have one slot per action. Everything is
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


describe("#79 confirmation tokens: payload binding, TTL, one slot per action", () => {
  it("refuses a token replayed with a different payload, sends nothing, and spends the token", async () => {
    const calls = installFetch();
    const account = makeAccount();
    const t = account.prepareMutation("cancel_order", { order_id: "A", hash: "h", part_id: "1", reason: 0 }).confirmationToken;
    await expect(account.cancelOrder("B", "h", "1", 0, t)).rejects.toThrow(/differ from the payload confirmed/);
    expect(calls).toEqual([]);
    // The mismatch spent the token: even the confirmed payload is refused now.
    await expect(account.cancelOrder("A", "h", "1", 0, t)).rejects.toThrow(/Invalid or expired cancel_order confirmation token/);
    expect(calls).toEqual([]);
  });

  it("refuses order B with the token of a failed order-A attempt (QA repro)", async () => {
    const calls = installFetch((url) => (url.includes("/orders/A/") ? json({ error: "boom" }, 500) : undefined));
    const account = makeAccount();
    const t = account.prepareMutation("cancel_order", { order_id: "A", hash: "h", part_id: "1" }).confirmationToken;
    await expect(account.cancelOrder("A", "h", "1", 0, t)).rejects.toThrow(/HTTP 500/);
    await expect(account.cancelOrder("B", "h", "1", 0, t)).rejects.toThrow(/Invalid or expired cancel_order confirmation token/);
    expect(calls.some((c) => c.includes("/orders/B/"))).toBe(false);
  });

  it("accepts the confirmed payload with omitted defaulted arguments and in any key order", async () => {
    const calls = installFetch();
    const account = makeAccount();
    // reason omitted here; the tool schema fills reason: 0 on the call.
    const t = account.prepareMutation("cancel_order", { part_id: "1", hash: "h", order_id: "A" }).confirmationToken;
    await expect(account.cancelOrder("A", "h", "1", 0, t)).resolves.toMatchObject({ accepted: true, order_id: "A" });
    expect(calls).toHaveLength(2);
    // A non-default value is part of the binding.
    const t2 = account.prepareMutation("cancel_order", { order_id: "A", hash: "h", part_id: "1" }).confirmationToken;
    await expect(account.cancelOrder("A", "h", "1", 5, t2)).rejects.toThrow(/differ from the payload confirmed/);
  });

  it("binds mutate_list tokens to its payload", async () => {
    const calls = installFetch();
    const account = makeAccount();
    const t = account.prepareMutation("coupon_add", { coupon: "SAVE10" }).confirmationToken;
    await expect(account.mutateList("coupon_add", t, { coupon: "OTHER" })).rejects.toThrow(/differ from the payload confirmed/);
    const t2 = account.prepareMutation("coupon_add", { coupon: "SAVE10" }).confirmationToken;
    await expect(account.mutateList("coupon_add", t2, { coupon: "SAVE10" })).resolves.toBeDefined();
    expect(calls.filter((c) => c.includes("addcoupon"))).toHaveLength(1);
  });

  it("expires a token after 5 minutes (fake clock) and sends nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const calls = installFetch();
    const account = makeAccount();
    const prepared = account.prepareMutation("coupon_add", { coupon: "A" });
    expect(prepared.expiresAt).toBe("2026-10-07T12:05:00.000Z");
    expect(MUTATION_TOKEN_TTL_MS).toBe(5 * 60 * 1000);
    vi.setSystemTime(new Date("2026-10-07T12:05:00Z"));
    await expect(account.mutateList("coupon_add", prepared.confirmationToken, { coupon: "A" })).rejects.toThrow(/expired/);
    expect(calls).toEqual([]);
    // Just inside the window it is accepted.
    const fresh = account.prepareMutation("coupon_add", { coupon: "A" });
    vi.setSystemTime(new Date("2026-10-07T12:09:59Z"));
    await expect(account.mutateList("coupon_add", fresh.confirmationToken, { coupon: "A" })).resolves.toBeDefined();
  });

  it("keeps one pending token per action: other actions survive, re-preparing an action replaces it", async () => {
    const calls = installFetch();
    const account = makeAccount();
    const add = account.prepareMutation("coupon_add", { coupon: "A" }).confirmationToken;
    const remove = account.prepareMutation("coupon_remove", { couponId: 7 }).confirmationToken;
    const stale = account.prepareMutation("basket_unlock", {}).confirmationToken;
    const current = account.prepareMutation("basket_unlock", {}).confirmationToken;
    await expect(account.mutateList("coupon_add", add, { coupon: "A" })).resolves.toBeDefined();
    await expect(account.mutateList("coupon_remove", remove, { couponId: 7 })).resolves.toBeDefined();
    await expect(account.mutateList("basket_unlock", stale, {})).rejects.toThrow(/Invalid or expired/);
    await expect(account.mutateList("basket_unlock", current, {})).resolves.toBeDefined();
    expect(calls).toHaveLength(3);
  });

  it("does not let a token prepared for one action unlock another", async () => {
    installFetch();
    const account = makeAccount();
    const t = account.prepareMutation("coupon_add", { coupon: "A" }).confirmationToken;
    await expect(account.mutateList("coupon_remove", t, { couponId: 1 })).rejects.toThrow(/Invalid or expired/);
    await expect(account.mutateList("coupon_add", t, { coupon: "A" })).resolves.toBeDefined();
  });

  it("expires the checkout_preview token after 5 minutes too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const calls = installFetch();
    const account = makeAccount();
    const preview = await account.previewOrder();
    calls.length = 0;
    vi.setSystemTime(new Date("2026-10-07T12:05:00Z"));
    await expect(account.submitOrder(preview.confirmationToken, {}, {}, {})).rejects.toThrow(/checkout token expired/);
    expect(calls).toEqual([]);
  });

  it("requires a payload on the prepare_mutation tool and enforces it end to end", async () => {
    const calls = installFetch();
    const client = await connect();
    const missing = await client.callTool({ name: "prepare_mutation", arguments: { action: "cancel_order" } });
    expect(missing.isError).toBe(true);
    const args = { order_id: "A", part_id: "1", hash: "h" };
    const prepared = await client.callTool({ name: "prepare_mutation", arguments: { action: "cancel_order", payload: args } });
    const sc = prepared.structuredContent as { confirmationToken: string; payloadBound: boolean; expiresAt: string };
    expect(sc.payloadBound).toBe(true);
    expect(Date.parse(sc.expiresAt)).toBeGreaterThan(Date.now());
    const swapped = await client.callTool({ name: "cancel_order", arguments: { ...args, order_id: "B", confirmation_token: sc.confirmationToken } });
    expect(swapped.isError).toBe(true);
    expect(text(swapped)).toMatch(/differ from the payload confirmed/);
    expect(calls).toEqual([]);
    const again = await client.callTool({ name: "prepare_mutation", arguments: { action: "cancel_order", payload: args } });
    const ok = await client.callTool({ name: "cancel_order", arguments: { ...args, confirmation_token: (again.structuredContent as { confirmationToken: string }).confirmationToken } });
    expect(ok.isError, text(ok)).toBeFalsy();
  });

  it("keeps MUTATION_PAYLOAD_DEFAULTS in sync with the mutation tools' schema defaults", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const toolToAction: Record<string, string> = { web_pay_after_order: "web_after_order_payment" };
    const tokenTools = tools.filter((t) => "confirmation_token" in ((t.inputSchema.properties ?? {}) as Record<string, unknown>) && t.name !== "place_order");
    expect(tokenTools.length).toBeGreaterThan(15);
    for (const t of tokenTools) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, { default?: unknown }>;
      const defaults = Object.fromEntries(Object.entries(props).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default]));
      if (t.name === "mutate_list") { expect(defaults).toEqual({}); continue; }
      const action = toolToAction[t.name] ?? (t.name === "address_upsert" ? "address_create" : t.name === "upload_attachment" ? "attachment_upload" : t.name === "pay_after_order" ? "after_order_payment" : t.name);
      expect(defaults, t.name).toEqual(MUTATION_PAYLOAD_DEFAULTS[action] ?? {});
    }
  });
});
