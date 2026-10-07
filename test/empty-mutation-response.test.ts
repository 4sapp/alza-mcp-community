import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { createAccountTools } from "../src/tools/account.js";
import { createAdvancedTools } from "../src/tools/advanced.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

/**
 * Issue #63: a 2xx response whose body is empty (204/202), an array, or text
 * must not be reported as an error after the request was sent and the token
 * spent. Only the account tools are registered on a bare McpServer (no
 * browser, no Chrome-fingerprint sidecar), and fetch is mocked: no network.
 */
const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

let upstream: () => Response = () => new Response(null, { status: 204 });
const calls: string[] = [];
function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return upstream();
  }) as typeof fetch;
}

async function connect() {
  const mobileAccount = new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }));
  const deps = { mobileAccount } as unknown as ToolDeps;
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  const wrap = async (_name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try { return await fn(); } catch (err) { return { content: [{ type: "text", text: String(err) }], isError: true }; }
  };
  for (const tool of [...createAccountTools(deps), ...createAdvancedTools(deps)]) tool.register(server, wrap);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function token(client: Client, action: string): Promise<string> {
  const res = await client.callTool({ name: "prepare_mutation", arguments: { action } });
  return (res.structuredContent as { confirmationToken: string }).confirmationToken;
}

const bodies: Array<[string, () => Response]> = [
  ["204 no content", () => new Response(null, { status: 204 })],
  ["202 empty body", () => new Response("", { status: 202 })],
  ["200 JSON null", () => new Response("null", { status: 200 })],
  ["200 JSON array", () => new Response("[1,2]", { status: 200 })],
  ["200 HTML text", () => new Response("<html>ok</html>", { status: 200 })],
];

describe("non-object 2xx bodies are reported as accepted, not as errors (#63)", () => {
  for (const [label, response] of bodies) {
    it(`pay_after_order, address_delete, review_submit and mutate_list succeed on ${label}`, async () => {
      installFetch();
      upstream = response;
      calls.length = 0;
      const client = await connect();
      const action = (href: string) => ({ form: { meta: { href, method: "POST", rel: ["form"] }, values: [] } });
      // [tool, prepare_mutation action, arguments]; one token slot, so prepare right before each call.
      const runs: Array<[string, string, Record<string, unknown>]> = [
        ["pay_after_order", "after_order_payment", { order_id: "O1", invoice_number: "I1", payment_id: 7 }],
        ["address_delete", "address_delete", { action: action("/api/users/1/addresses/4/delete"), address_id: 4 }],
        ["review_submit", "review_submit", { action: action("/services/restservice.svc/v1/writeReview"), rating: 5 }],
        ["mutate_list", "coupon_add", { action: "coupon_add", payload: { coupon: "SAVE10" } }],
      ];
      for (const [name, prepared, args] of runs) {
        const res = await client.callTool({ name, arguments: { ...args, confirmation_token: await token(client, prepared) } });
        expect(res.isError, `${name}: ${JSON.stringify(res.content)}`).toBeFalsy();
        const sc = res.structuredContent as Record<string, unknown>;
        expect(sc.accepted).toBe(true);
        expect(typeof sc.note).toBe("string");
        expect(sc).toHaveProperty("data");
      }
      expect(calls).toHaveLength(4);
    });
  }

  it("wraps an empty body on the concise-text path (add_to_cart) as well", async () => {
    installFetch();
    upstream = () => new Response(null, { status: 204 });
    const client = await connect();
    const res = await client.callTool({ name: "add_to_cart", arguments: { code: "ABC123" } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect((res.structuredContent as Record<string, unknown>).accepted).toBe(true);
  });

  it("keeps object bodies unchanged", async () => {
    installFetch();
    upstream = () => new Response(JSON.stringify({ err: 0, msg: null, data: { id: 1 } }), { status: 200 });
    const client = await connect();
    const res = await client.callTool({ name: "pay_after_order", arguments: { order_id: "O1", invoice_number: "I1", payment_id: 7, confirmation_token: await token(client, "after_order_payment") } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ err: 0, msg: null, data: { id: 1 } });
  });
});
