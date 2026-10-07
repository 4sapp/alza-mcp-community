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
 * Issue #79: user_id is checked against the signed-in account. Everything is
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


describe("#79 user_id is checked against the signed-in account", () => {
  const userData = (id: unknown) => (url: string) => (url.endsWith("/v2/getUserData") ? json({ err: 0, user_id: id }) : undefined);

  it("refuses an identity mutation for another user id and sends no PATCH", async () => {
    const calls = installFetch(userData(Number(UID)));
    const account = makeAccount();
    const payload = { user_id: OTHER_UID, email: "x@example.org" };
    const t = account.prepareMutation("email_change", payload).confirmationToken;
    await expect(account.emailChange(payload, t)).rejects.toThrow(`email_change refused: user_id ${OTHER_UID} is not the signed-in account`);
    expect(calls.filter((c) => !c.includes("getUserData"))).toEqual([]);
  });

  it("fails closed for all five credential/identity mutations when the user id cannot be confirmed", async () => {
    const cases: Array<[string, Record<string, unknown>, (a: MobileAccount, p: Record<string, unknown>, t: string) => Promise<unknown>]> = [
      ["change_password", { user_id: UID, old_password: "oldpass1", new_password: "newpass12", new_password_confirm: "newpass12" }, (a, p, t) => a.changePassword(p, t)],
      ["email_change", { user_id: UID, email: "x@example.org" }, (a, p, t) => a.emailChange(p, t)],
      ["phone_change", { user_id: UID, phone: "+420777123456" }, (a, p, t) => a.phoneChange(p, t)],
      ["delete_account", { user_id: UID }, (a, p, t) => a.deleteAccount(p, t)],
      ["two_factor_set", { user_id: UID, enabled: false }, (a, p, t) => a.twoFactorSet(p, t)],
    ];
    for (const [answer, pattern] of [
      [userData(-1), /did not report a signed-in user id/],
      [userData(undefined), /did not report a signed-in user id/],
      [(url: string) => (url.endsWith("/v2/getUserData") ? json({ error: "down" }, 503) : undefined), /user_data read failed/],
    ] as const) {
      for (const [action, payload, run] of cases) {
        const calls = installFetch(answer);
        const account = makeAccount();
        const t = account.prepareMutation(action, payload).confirmationToken;
        await expect(run(account, payload, t), action).rejects.toThrow(pattern);
        expect(calls.filter((c) => !c.includes("getUserData")), action).toEqual([]);
      }
    }
  });

  it("sends the identity mutation when user_data confirms the same user id", async () => {
    const calls = installFetch(userData(Number(UID)));
    const account = makeAccount();
    const payload = { user_id: UID, enabled: true };
    const t = account.prepareMutation("two_factor_set", payload).confirmationToken;
    await expect(account.twoFactorSet(payload, t)).resolves.toBeDefined();
    expect(calls.at(-1)).toBe(`PATCH https://www.alza.cz/api/users/${UID}/v1/account?country=CZ`);
  });

  it("refuses other user-scoped routes for a different id once profile has reported the signed-in id", async () => {
    const calls = installFetch(userData(Number(UID)));
    const account = makeAccount();
    await account.profile();
    calls.length = 0;
    await expect(account.orderSearch("1058", OTHER_UID)).rejects.toThrow(/is not the signed-in account/);
    await expect(account.watchdogList(OTHER_UID)).rejects.toThrow(/is not the signed-in account/);
    const payload = { user_id: OTHER_UID };
    await expect(account.mutateList("gdpr_export", account.prepareMutation("gdpr_export", payload).confirmationToken, payload)).rejects.toThrow(/is not the signed-in account/);
    await expect(account.read("premium_trial", { user_id: OTHER_UID })).rejects.toThrow(/is not the signed-in account/);
    expect(calls).toEqual([]);
    // The signed-in id itself is still accepted.
    await account.orderSearch("1058", UID);
    expect(calls).toHaveLength(1);
  });

  it("does not refuse user-scoped reads while the signed-in id is unknown", async () => {
    const calls = installFetch();
    await makeAccount().orderSearch("1058", OTHER_UID);
    expect(calls).toHaveLength(1);
  });
});
