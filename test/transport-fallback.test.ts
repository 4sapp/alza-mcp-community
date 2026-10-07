import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError, OutcomeUnknownError } from "../src/infra/errors.js";
import { ImpersonateTransport, TransportUnavailableError } from "../src/infra/impersonate-transport.js";
import { MobileApi, type HttpFetch } from "../src/infra/mobile-api.js";
import { proxyFromEnv } from "../src/infra/proxy.js";
import { friendlyError } from "../src/server.js";

process.env.ALZA_TOKEN_FILE = "none";

/** Global fetch double: counts plain-fetch replays; never touches the network. */
let plainCalls: Array<{ url: string; method: string }> = [];
let savedProxy: string | undefined;

beforeEach(() => {
  plainCalls = [];
  savedProxy = process.env.ALZA_PROXY_URL;
  delete process.env.ALZA_PROXY_URL;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    plainCalls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ ErrorLevel: 0 }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedProxy === undefined) delete process.env.ALZA_PROXY_URL; else process.env.ALZA_PROXY_URL = savedProxy;
});

/** A sidecar that fails every request with `err`, recording what it was handed. */
function failingSidecar(err: Error) {
  const sent: Array<{ url: string; method?: string }> = [];
  const httpFetch: HttpFetch = async (url, init) => {
    sent.push({ url, method: init.method });
    throw err;
  };
  return { httpFetch, sent };
}

const AMBIGUOUS = [
  new Error("cf-transport: request timed out after 60000ms"),
  new Error("cf-transport: curl: (28) Operation timed out after 1000 milliseconds"),
  new Error("cf-transport: sidecar exited (1) while a request was in flight"),
];

describe("#57: no automatic replay of mutations after an ambiguous sidecar failure", () => {
  const mutations: Array<[string, (api: MobileApi) => Promise<unknown>]> = [
    ["POST SendOrder4 (web_place_order)", (api) => api.webWcfStep("SendOrder4", { orderId: 1 })],
    ["POST CreateAfterPayment (web_after_order_payment)", (api) => api.webWcfStep("CreateAfterPayment", { orderId: 1 })],
    ["POST afterOrderPayment (pay_after_order)", (api) => api.afterOrderPayment({ id: "1", invoiceNumber: "1", paymentId: 1 })],
    ["PATCH account (phone_change)", (api) => api.changePhone("100000001", "+420000000000")],
    ["DELETE account (delete_account)", (api) => api.deleteAccount("100000001")],
  ];

  for (const err of AMBIGUOUS) {
    for (const [label, call] of mutations) {
      it(`${label} is sent once and reports an unknown outcome on "${err.message}"`, async () => {
        const { httpFetch, sent } = failingSidecar(err);
        const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, loadTokenFile: false });
        const outcome = await call(api).then(() => undefined, (e: unknown) => e);
        expect(outcome).toBeInstanceOf(OutcomeUnknownError);
        expect((outcome as Error).message).toMatch(/may or may not have reached Alza/);
        expect((outcome as Error).message).toMatch(/NOT retried/);
        expect(sent).toHaveLength(1);
        expect(plainCalls).toHaveLength(0);
      });
    }
  }

  it("still falls back for a mutation when the sidecar provably never sent it", async () => {
    const { httpFetch, sent } = failingSidecar(new TransportUnavailableError("spawn failed"));
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, loadTokenFile: false });
    await expect(api.webWcfStep("SendOrder4", { orderId: 1 })).resolves.toEqual({ ErrorLevel: 0 });
    expect(sent).toHaveLength(1);
    expect(plainCalls).toEqual([{ url: "https://alza.test/Services/EShopService.svc/SendOrder4", method: "POST" }]);
  });

  it("still falls back for an idempotent GET after an ambiguous failure", async () => {
    const { httpFetch } = failingSidecar(AMBIGUOUS[0]!);
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, loadTokenFile: false });
    await expect(api.userData()).resolves.toEqual({ ErrorLevel: 0 });
    expect(plainCalls).toHaveLength(1);
  });

  it("does not replay a single-use OAuth token POST after an ambiguous failure", async () => {
    const httpFetch: HttpFetch = async (url) => {
      if (url.includes("openid-configuration")) return { status: 200, text: async () => JSON.stringify({ token_endpoint: "https://identity.test/connect/token" }) };
      throw AMBIGUOUS[0]!;
    };
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, loadTokenFile: false });
    const start = await api.startOAuth();
    await expect(api.exchangeOAuthCode("code-1", start.state)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(plainCalls).toHaveLength(0);
  });

  it("the sidecar rejects in-flight requests with an ambiguous error, never TransportUnavailableError", async () => {
    const transport = new ImpersonateTransport({ enabled: true });
    const internals = transport as unknown as {
      pending: Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
      killAll(reason: string): void;
    };
    const rejected = new Promise<Error>((resolve) => {
      internals.pending.set(1, { resolve: () => undefined, reject: resolve, timer: setTimeout(() => undefined, 0) });
    });
    internals.killAll("sidecar exited (1)");
    const err = await rejected;
    expect(err).not.toBeInstanceOf(TransportUnavailableError);
    expect(err.message).toMatch(/in flight/);
    transport.close();
  });

  it("friendlyError does not tell the agent to blindly retry", () => {
    const unknown = friendlyError(new OutcomeUnknownError("POST", "alza.test/Services/EShopService.svc/SendOrder4", AMBIGUOUS[0]));
    expect(unknown).toMatch(/may or may not have reached Alza/);
    expect(unknown).not.toMatch(/please retry/i);
    const timeout = friendlyError(new Error("page.goto: Timeout 30000ms exceeded"));
    expect(timeout).not.toMatch(/please retry/i);
    expect(timeout).toMatch(/check its current state before retrying/);
  });
});

describe("#69: ALZA_PROXY_URL validation and no un-proxied fallback", () => {
  it("reports invalid values as ConfigurationError, including bad percent-escapes", () => {
    for (const value of ["ftp://x:1", ":::", "http://bob:100%@h:1", "http://%zz:pw@h:1"]) {
      expect(() => proxyFromEnv({ ALZA_PROXY_URL: value }), value).toThrow(ConfigurationError);
    }
    expect(() => proxyFromEnv({ ALZA_PROXY_URL: "http://bob:100%@h:1" })).toThrow(/invalid percent-escape/);
  });

  it("does not fall back to plain fetch when the proxied sidecar fails", async () => {
    process.env.ALZA_PROXY_URL = "http://proxy.test:3128";
    const { httpFetch } = failingSidecar(new Error("cf-transport: curl: (5) Could not resolve proxy: proxy.test"));
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, loadTokenFile: false });
    const err = await api.userData().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toMatch(/does not fall back to an un-proxied connection/);
    expect(plainCalls).toHaveLength(0);
  });

  it("does not use plain fetch when the sidecar is unavailable and a proxy is set", async () => {
    process.env.ALZA_PROXY_URL = "socks5://proxy.test:1080";
    const api = new MobileApi({ baseUrl: "https://alza.test", loadTokenFile: false });
    await expect(api.userData()).rejects.toBeInstanceOf(ConfigurationError);
    const oauth = new MobileApi({ baseUrl: "https://alza.test", httpFetch: failingSidecar(new TransportUnavailableError("spawn failed")).httpFetch, loadTokenFile: false });
    await expect(oauth.discovery()).rejects.toBeInstanceOf(ConfigurationError);
    expect(plainCalls).toHaveLength(0);
  });

  it("uses the (proxied) browser instead of plain fetch when a proxy is set", async () => {
    process.env.ALZA_PROXY_URL = "http://proxy.test:3128";
    const { httpFetch } = failingSidecar(new TransportUnavailableError("spawn failed"));
    const page = {
      url: () => "https://alza.test/",
      evaluate: async () => ({ status: 200, text: JSON.stringify({ via: "browser" }) }),
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
    };
    const browser = { withPage: async <T>(fn: (p: never) => Promise<T>) => fn(page as never) };
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, browser, loadTokenFile: false });
    await expect(api.userData()).resolves.toEqual({ via: "browser" });
    expect(plainCalls).toHaveLength(0);
  });

  it("without a proxy the existing plain-fetch fallback is unchanged", async () => {
    const { httpFetch } = failingSidecar(new TransportUnavailableError("spawn failed"));
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch, loadTokenFile: false });
    await expect(api.userData()).resolves.toEqual({ ErrorLevel: 0 });
    expect(plainCalls).toHaveLength(1);
  });
});
