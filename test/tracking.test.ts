import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tagLinks, withTracking } from "../src/tools/tracking.js";
import { createGetProductTool } from "../src/tools/get-product.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

const UTM = "utm_source=alza-mcp-community&utm_medium=mcp";

describe("withTracking", () => {
  it("tags storefront URLs on every supported locale, keeping existing params and the hash", () => {
    expect(withTracking("https://www.alza.cz/philips-27e1n1600ae-d7891234.htm")).toBe(`https://www.alza.cz/philips-27e1n1600ae-d7891234.htm?${UTM}`);
    expect(withTracking("https://www.alza.sk/x.htm?dq=123#reviews")).toBe(`https://www.alza.sk/x.htm?dq=123&${UTM}#reviews`);
    for (const tld of ["hu", "at", "de", "co.uk"]) expect(withTracking(`https://www.alza.${tld}/`)).toContain(UTM);
  });

  it("does not duplicate parameters when a URL is already tagged", () => {
    const once = withTracking("https://www.alza.cz/a.htm?utm_source=other");
    expect(withTracking(once)).toBe(once);
    expect(new URL(once).searchParams.getAll("utm_source")).toEqual(["alza-mcp-community"]);
  });

  it("leaves non-storefront, invalid and relative URLs alone", () => {
    for (const url of [
      "https://identity.alza.cz/connect/authorize?client_id=alza_Android",
      "https://webapi.alza.cz/api/catalog/commodities/1/reviews",
      "https://pdf.alza.cz/invoice.pdf",
      "https://cdn.alza.cz/Foto/f16/RI/RI045b1.jpg",
      "https://www.alza.cz.evil.example/",
      "https://notalza.cz/",
      "alza://identity?code=x",
      "/relative/path.htm",
      "not a url",
    ]) {
      expect(withTracking(url)).toBe(url);
    }
  });
});

describe("tagLinks", () => {
  it("tags only `url` fields, deeply, and never mutates its input", () => {
    const cached = {
      name: "Monitor",
      url: "https://www.alza.cz/m.htm",
      image: "https://cdn.alza.cz/m.jpg",
      description: "see https://www.alza.cz/other.htm",
      parts: [{ url: "https://www.alza.cz/cpu.htm", price: 5000 }, { url: null }],
      nested: { deep: { url: "https://www.alza.cz/deep.htm" } },
    };
    const snapshot = JSON.stringify(cached);
    const out = tagLinks(cached);
    expect(JSON.stringify(cached)).toBe(snapshot);
    expect(out).not.toBe(cached);
    expect(out.url).toBe(`https://www.alza.cz/m.htm?${UTM}`);
    expect(out.parts[0]!.url).toBe(`https://www.alza.cz/cpu.htm?${UTM}`);
    expect(out.parts[1]!.url).toBeNull();
    expect(out.nested.deep.url).toBe(`https://www.alza.cz/deep.htm?${UTM}`);
    expect(out.image).toBe(cached.image);
    expect(out.description).toBe(cached.description);
    expect(out.parts[0]!.price).toBe(5000);
  });
});

describe("get_product over MCP", () => {
  it("returns the tagged URL in text and structuredContent while the cached product stays untagged", async () => {
    const cached = { code: "RI045b1", id: 123, name: "Test monitor", url: "https://www.alza.cz/test-d123.htm", price: 4990, currency: "CZK", params: [] };
    const deps = { catalog: { getProduct: async () => cached } } as unknown as ToolDeps;
    const server = new McpServer({ name: "t", version: "0" });
    const wrap = async (_: string, fn: () => Promise<ToolResult>) => fn();
    createGetProductTool(deps).register(server, wrap);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await server.connect(a);
    await client.connect(b);
    try {
      const res = await client.callTool({ name: "get_product", arguments: { code: "RI045b1" } });
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      const product = (res.structuredContent as { product: { url: string } }).product;
      expect(product.url).toBe(`https://www.alza.cz/test-d123.htm?${UTM}`);
      expect((res.content as Array<{ text: string }>)[0]!.text).toContain(`test-d123.htm?${UTM}`);
      expect(cached.url).toBe("https://www.alza.cz/test-d123.htm");
    } finally {
      await client.close();
    }
  });
});
