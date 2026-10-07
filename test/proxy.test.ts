import { describe, expect, it } from "vitest";
import { proxyFromEnv } from "../src/infra/proxy.js";

describe("proxyFromEnv (ALZA_PROXY_URL)", () => {
  it("is off when unset or blank", () => {
    expect(proxyFromEnv({})).toBeUndefined();
    expect(proxyFromEnv({ ALZA_PROXY_URL: "  " })).toBeUndefined();
  });

  it("splits credentials out of the server URL for Playwright", () => {
    expect(proxyFromEnv({ ALZA_PROXY_URL: "http://user%40x:p%3Ass@proxy.example:8080" })).toEqual({
      server: "http://proxy.example:8080",
      username: "user@x",
      password: "p:ss",
    });
  });

  it("accepts socks5 without credentials", () => {
    expect(proxyFromEnv({ ALZA_PROXY_URL: "socks5://127.0.0.1:1080" })).toEqual({ server: "socks5://127.0.0.1:1080" });
  });

  it("rejects malformed values and unsupported schemes", () => {
    expect(() => proxyFromEnv({ ALZA_PROXY_URL: "not a url" })).toThrow(/not a valid URL/);
    expect(() => proxyFromEnv({ ALZA_PROXY_URL: "ftp://proxy:21" })).toThrow(/not supported/);
  });
});
