import { describe, expect, it, vi } from "vitest";
import { cfFetch, type ImpersonateTransport } from "../src/infra/impersonate-transport.js";

/** Minimal transport double — records what cfFetch hands to the sidecar. */
function fakeTransport() {
  const seen: Array<{ url: string; body: string | null | undefined }> = [];
  const transport = {
    request: vi.fn(async (req: { url: string; body?: string | null }) => {
      seen.push({ url: req.url, body: req.body });
      return { status: 200, headers: {}, body: Buffer.from("{}") };
    }),
  } as unknown as ImpersonateTransport;
  return { transport, seen };
}

describe("cfFetch body routing", () => {
  it("sends URLSearchParams through the sidecar as an urlencoded string", async () => {
    const { transport, seen } = fakeTransport();
    const body = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await cfFetch(transport)("https://identity.alza.cz/connect/token", { method: "POST", body });

    // Routing this to native fetch would put every OAuth token request back behind
    // Cloudflare's bot wall (HTTP 403), which is what broke authentication entirely.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toBe("grant_type=authorization_code&code=abc");
  });

  it("still sends plain string bodies through the sidecar", async () => {
    const { transport, seen } = fakeTransport();
    await cfFetch(transport)("https://www.alza.cz/x", { method: "POST", body: "raw" });
    expect(seen[0]?.body).toBe("raw");
  });

  it("leaves opaque bodies on the native fetch path", async () => {
    const { transport, seen } = fakeTransport();
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      await cfFetch(transport)("https://www.alza.cz/upload", { method: "POST", body: new Blob(["x"]) });
      expect(seen).toHaveLength(0);
      expect(nativeFetch).toHaveBeenCalledOnce();
    } finally {
      nativeFetch.mockRestore();
    }
  });
});
