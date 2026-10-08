import { describe, expect, it } from "vitest";
import { Catalog } from "../src/domain/catalog.js";
import type { AlzaBrowser } from "../src/infra/browser.js";

// A stub browser whose page access fails with a sentinel: the tests only care whether the
// blank-query guard fires before any page is touched.
const browser = {
  locale: { baseUrl: "https://www.alza.cz", countryCode: "CZ", currency: "CZK", acceptLanguage: "cs-CZ" },
  baseUrl: "https://www.alza.cz",
  withPage: async () => {
    throw new Error("sentinel: page access");
  },
} as unknown as AlzaBrowser;

describe("searchProducts blank query", () => {
  it("rejects a blank keyword search", async () => {
    await expect(new Catalog(browser).searchProducts({ query: "   " })).rejects.toThrow(/query must not be blank/);
    await expect(new Catalog(browser).searchProducts({ query: "", categoryId: 18842948 })).rejects.toThrow(/query must not be blank/);
  });

  it("allows a blank query for facet searches, where the category browse ignores it", async () => {
    await expect(new Catalog(browser).searchProducts({ query: "", categoryId: 18842948, producerIds: [1357] })).rejects.toThrow(/sentinel/);
    await expect(
      new Catalog(browser).searchProducts({ query: "", categoryId: 18842948, filters: [{ paramId: 1, valueId: 2 }] } as never),
    ).rejects.toThrow(/sentinel/);
  });
});
