import { describe, expect, it } from "vitest";
import { MobileApi } from "../src/infra/mobile-api.js";

describe("MobileApi.parseOAuthRedirect", () => {
  it("passes a bare code through with the explicit state", () => {
    expect(MobileApi.parseOAuthRedirect("abc123", "s1")).toEqual({ code: "abc123", state: "s1" });
  });

  it("extracts code and state from a pasted alza://identity redirect", () => {
    expect(MobileApi.parseOAuthRedirect(" alza://identity?code=C0DE&scope=openid&state=s1&session_state=x ")).toEqual({ code: "C0DE", state: "s1" });
  });

  it("accepts a matching explicit state alongside the URL", () => {
    expect(MobileApi.parseOAuthRedirect("alza://identity?code=C0DE&state=s1", "s1")).toEqual({ code: "C0DE", state: "s1" });
  });

  it("rejects a URL whose state disagrees with the explicit one", () => {
    expect(() => MobileApi.parseOAuthRedirect("alza://identity?code=C0DE&state=s1", "other")).toThrow(/does not match/);
  });

  it("rejects a redirect URL without a code", () => {
    expect(() => MobileApi.parseOAuthRedirect("alza://identity?error=access_denied&state=s1")).toThrow(/code/);
  });

  it("refuses the exchange when no state can be determined", async () => {
    const api = new MobileApi();
    await expect(api.exchangeOAuthCode("abc123")).rejects.toThrow(/state/);
  });
});
