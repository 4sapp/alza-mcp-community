import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { createAccountTools } from "../src/tools/account.js";
import { createAdvancedTools } from "../src/tools/advanced.js";
import { TEXT_CHANNEL_LIMIT } from "../src/tools/account-format.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

// Keep unit tests deterministic: never auto-load a real stored OAuth token.
process.env.ALZA_TOKEN_FILE = "none";

type Seen = { url: string; method: string };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function stubFetch(handler: (url: string) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET" });
    return handler(url);
  }) as typeof fetch);
  return seen;
}

const makeAccount = () => new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }));

/** In-memory MCP client over just the account + advanced tools (no browser, no sidecar). */
async function connectTools(account: MobileAccount) {
  const server = new McpServer({ name: "account-reads-test", version: "0" });
  const wrap = async (_name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try { return await fn(); } catch (err) { return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true }; }
  };
  const deps = { mobileAccount: account } as unknown as ToolDeps;
  for (const tool of [...createAccountTools(deps), ...createAdvancedTools(deps)]) tool.register(server, wrap);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "account-reads-test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
      return { text, structured: res.structuredContent as Record<string, unknown> | undefined, isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

describe("issue #60: user-order reads use the numeric user id", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mobile_read user_order sends /api/users/{userId}/, never the 0/1 flag", async () => {
    const account = makeAccount();
    const seen = stubFetch(() => json({ orderId: "1058" }));
    await expect(account.read("user_order", { order_id: "1058", user_flag: 0 })).rejects.toThrow(/user_id/);
    await expect(account.read("user_order", { order_id: "1058", user_id: "1" })).rejects.toThrow(/user_flag/);
    expect(seen).toHaveLength(0);
    const out = await account.read("user_order", { order_id: "1058", user_id: "100000001" });
    expect(out).toEqual({ orderId: "1058" });
    expect(seen[0].url).toBe("https://test.alza.invalid/api/users/100000001/v1/orders/1058?country=CZ");
  });

  it("the typed order tool requires user_id and puts it in the route", async () => {
    const account = makeAccount();
    const seen = stubFetch(() => json({ orderId: "1058", parts: [] }));
    const mcp = await connectTools(account);
    try {
      const missing = await mcp.call("order", { order_id: "1058" });
      expect(missing.isError).toBe(true);
      expect(seen).toHaveLength(0);
      const ok = await mcp.call("order", { order_id: "1058", user_id: "100000001" });
      expect(ok.isError).toBe(false);
      expect(seen[0].url).toBe("https://test.alza.invalid/api/users/100000001/v1/orders/1058?country=CZ");
    } finally { await mcp.close(); }
  });
});

describe("issue #72: claim / subscription / address reads work without a hand-made AppAction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("complaint_claims reads the active or archive list by user_id", async () => {
    const account = makeAccount();
    const seen = stubFetch(() => json({ warrantyClaims: [] }));
    const mcp = await connectTools(account);
    try {
      const active = await mcp.call("complaint_claims", { user_id: "100000001" });
      expect(active.isError).toBe(false);
      const archive = await mcp.call("complaint_claims", { user_id: "100000001", scope: "archive" });
      expect(archive.isError).toBe(false);
      expect(seen.map((s) => s.url)).toEqual([
        "https://test.alza.invalid/api/users/100000001/v1/warrantyClaims/active?country=CZ",
        "https://test.alza.invalid/api/users/100000001/v1/warrantyClaims/archive?country=CZ",
      ]);
      const none = await mcp.call("complaint_claims", {});
      expect(none.isError).toBe(true);
      expect(none.text).toMatch(/user_id/);
      expect(seen).toHaveLength(2);
    } finally { await mcp.close(); }
  });

  it("complaint_claims and claim_detail accept the plain links Alza returns, pinned to the claims family", async () => {
    const account = makeAccount();
    const seen = stubFetch(() => json({ claim: true }));
    const link = { href: "https://www.alza.cz/api/users/100000001/v1/warrantyClaims/active?country=CZ", appLink: "userWarrantyClaims", enabled: true };
    await account.complaintClaims(link);
    await account.claimDetail({ href: "https://webapi.alza.cz/api/users/100000001/v1/warrantyClaims/12345?country=CZ", appLink: "warrantyClaimDetail" });
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ["GET", "https://www.alza.cz/api/users/100000001/v1/warrantyClaims/active?country=CZ"],
      ["GET", "https://webapi.alza.cz/api/users/100000001/v1/warrantyClaims/12345?country=CZ"],
    ]);
    // GET-based mutations, foreign hosts and plain http are refused before any request
    await expect(account.claimDetail({ href: "https://www.alza.cz/services/restservice.svc/v1/addcoupon/FREE" })).rejects.toThrow(/route family/);
    await expect(account.claimDetail({ href: "https://evil.example/api/users/1/v1/warrantyClaims/1" })).rejects.toThrow(/https Alza API URL/);
    await expect(account.claimDetail({ href: "http://www.alza.cz/api/users/1/v1/warrantyClaims/1" })).rejects.toThrow(/https Alza API URL/);
    await expect(account.claimDetail({ href: "https://www.alza.cz/api/users/1/v1/warrantyClaims/../../../services/restservice.svc/v1/addcoupon/X" })).rejects.toThrow(/route family/);
    await expect(account.subscriptionOverview({ href: "https://webapi.alza.cz/api/users/1/v1/warrantyClaims/active" })).rejects.toThrow(/route family/);
    expect(seen).toHaveLength(2);
  });

  it("subscription_overview reads the navigation's userSubscription resource by user_id or link", async () => {
    const account = makeAccount();
    const seen = stubFetch(() => json({ title: "Odběry" }));
    const mcp = await connectTools(account);
    try {
      const byId = await mcp.call("subscription_overview", { user_id: "100000001" });
      expect(byId.isError).toBe(false);
      const byLink = await mcp.call("subscription_overview", { action: { href: "https://webapi.alza.cz/api/users/100000001/v1/subscription?country=CZ", appLink: "userSubscription", enabled: true } });
      expect(byLink.isError).toBe(false);
      expect(seen.map((s) => s.url)).toEqual([
        "https://webapi.alza.cz/api/users/100000001/v1/subscription?country=CZ",
        "https://webapi.alza.cz/api/users/100000001/v1/subscription?country=CZ",
      ]);
    } finally { await mcp.close(); }
  });

  it("address_search without an action uses the verified zip/city lookup", async () => {
    const account = makeAccount();
    const seen = stubFetch(() => json({ err: 0, data: [{ zip: "11000", city: "Praha" }] }));
    const mcp = await connectTools(account);
    try {
      const out = await mcp.call("address_search", { query: "110 00" });
      expect(out.isError).toBe(false);
      expect(seen[0].url).toBe("https://test.alza.invalid/services/restservice.svc/v1/getZipCodes?deliveryId=0&search=110+00");
    } finally { await mcp.close(); }
  });

  it("the profile description no longer promises claim/subscription actions", async () => {
    const tools = createAdvancedTools({ mobileAccount: makeAccount() } as unknown as ToolDeps);
    const server = new McpServer({ name: "d", version: "0" });
    const wrap = async (_n: string, fn: () => Promise<ToolResult>) => fn();
    const registered = tools.find((t) => t.name === "profile")!.register(server, wrap);
    expect(registered.description).not.toMatch(/`complaint_claims`, and the subscription tools/);
    expect(registered.description).toMatch(/user_id/);
  });
});

describe("issue #73: the text channel stays small; structuredContent keeps the data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("order_document never puts the base64 body in the text channel", async () => {
    const account = makeAccount();
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(300_000, 0x41)]);
    stubFetch(() => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }));
    const mcp = await connectTools(account);
    try {
      const out = await mcp.call("order_document", { document: { name: "Faktura", self: { href: "https://pdf.alza.cz/Apps/pdfdoc.asp?d=1P&x=h" } } });
      expect(out.isError).toBe(false);
      const base64 = String(out.structured?.base64);
      expect(Buffer.from(base64, "base64").equals(pdf)).toBe(true);
      expect(out.text).not.toContain(base64.slice(0, 40));
      expect(out.text.length).toBeLessThan(1_000);
      expect(out.text).toMatch(/application\/pdf/);
      expect(out.text).toMatch(/structuredContent\.base64/);
    } finally { await mcp.close(); }
  });

  it("delivery_options and payment_methods return a concise summary", async () => {
    const account = makeAccount();
    const delivery = (i: number) => ({ id: 2000 + i, name: `Delivery ${i}`, itemType: "AlzaBox", group: "Delivery", price: "69 Kč", legend: "<p>" + "x".repeat(2_000) + "</p>", associatedItems: [] });
    const payment = (i: number) => ({ id: 100 + i, name: `Payment ${i}`, itemType: "Card", groupName: "Online", legend: "<p>" + "y".repeat(2_000) + "</p>" });
    const env = { err: 0, deliveryGroups: [{ deliveryGroupId: 0, deliveries: Array.from({ length: 66 }, (_, i) => delivery(i)) }], payments: Array.from({ length: 16 }, (_, i) => payment(i)), warnings: ["<p>Notice <b>one</b></p>"], paymentTip: "" };
    stubFetch(() => json(env));
    const mcp = await connectTools(account);
    try {
      const d = await mcp.call("delivery_options", {});
      expect(JSON.stringify(env).length).toBeGreaterThan(150_000);
      expect(d.text.length).toBeLessThan(TEXT_CHANNEL_LIMIT);
      expect(d.text).toContain("[2000] Delivery 0 (AlzaBox, Delivery, 69 Kč)");
      expect(d.text).toContain("[115] Payment 15");
      expect(d.text).toContain("6 more in structuredContent");
      expect(d.text).toContain("Notice one");
      expect((d.structured?.deliveryGroups as unknown[]).length).toBe(1);

      const p = await mcp.call("payment_methods", {});
      expect(p.text.length).toBeLessThan(TEXT_CHANNEL_LIMIT);
      expect(p.text).toContain("[100] Payment 0 (Card, Online)");
      expect((p.structured?.payments as unknown[]).length).toBe(16);
    } finally { await mcp.close(); }
  });

  it("mobile_read caps a huge envelope's text and keeps the full value in structuredContent", async () => {
    const account = makeAccount();
    const big = { err: 0, data: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `item ${i}` })) };
    stubFetch(() => json(big));
    const mcp = await connectTools(account);
    try {
      const out = await mcp.call("mobile_read", { operation: "contacts" });
      expect(out.isError).toBe(false);
      expect(out.text.length).toBeLessThan(TEXT_CHANNEL_LIMIT + 300);
      expect(out.text).toMatch(/text truncated: showed 20000 of \d+ characters\. The complete result is in structuredContent/);
      expect((out.structured?.data as unknown[]).length).toBe(50_000);
    } finally { await mcp.close(); }
  });
});
