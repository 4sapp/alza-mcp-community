import { describe, expect, it, vi } from "vitest";
import { Alternatives, commodityIdFromUrl, matchesBrand, parseAlternatives, rankAlternatives } from "../src/domain/alternatives.js";
import type { Product } from "../src/domain/types.js";

const p = (code: string, name: string, price: number | undefined, rating?: number, extra: Partial<Product> = {}): Product => ({
  code, id: Number(code.replace(/\D/g, "")) || 0, name, url: `https://www.alza.cz/x-d${code.replace(/\D/g, "")}.htm`, price, currency: "CZK", rating, ...extra,
});

const source = p("A1", "Apple iPhone 17 256GB", 25990, 4.6, { brand: "Apple", id: 1 });
const pool: Product[] = [
  source,
  p("A2", "Apple iPhone 16 128GB", 19990, 4.8, { id: 2 }),
  p("A3", "Samsung Galaxy S25", 17990, 4.4, { id: 3 }),
  p("A4", "Xiaomi 15", 14990, undefined, { id: 4 }),
  p("A5", "Apple iPhone 17 Pro", 32990, 4.9, { id: 5 }),
  p("A6", "Apple iPhone 15", 25990, 4.6, { id: 6 }),
  p("A7", "Pineapple Phone", 9990, 4.7, { id: 7 }),
];

describe("rankAlternatives", () => {
  it("excludes the source and keeps Alza order without a mode", () => {
    expect(rankAlternatives(source, pool, undefined, 10).map((x) => x.code)).toEqual(["A2", "A3", "A4", "A5", "A6", "A7"]);
  });

  it("cheaper: strictly lower price only, cheapest first; unpriced never qualifies", () => {
    const r = rankAlternatives(source, pool, "cheaper", 10).map((x) => x.code);
    expect(r).toEqual(["A7", "A4", "A3", "A2"]);
    expect(r).not.toContain("A6"); // equal price is not cheaper
    expect(rankAlternatives({ ...source, price: undefined }, pool, "cheaper", 10)).toEqual([]);
  });

  it("same-brand: whole-word brand match, rating desc then price asc", () => {
    const r = rankAlternatives(source, pool, "same-brand", 10).map((x) => x.code);
    expect(r).toEqual(["A5", "A2", "A6"]);
    expect(r).not.toContain("A7"); // 'Pineapple' is not 'Apple'
    expect(rankAlternatives({ ...source, brand: undefined }, pool, "same-brand", 10)).toEqual([]);
  });

  it("same-brand: names that omit the brand match on the shared leading token", () => {
    const iphone = p("I1", "iPhone 17 256GB", 25990, 4.8, { brand: "Apple", id: 11 });
    const others = [iphone, p("I2", "iPhone 17 Pro 256GB", 29990, 4.9, { id: 12 }), p("I3", "Galaxy S26", 26000, 4.9, { id: 13 })];
    expect(rankAlternatives(iphone, others, "same-brand", 10).map((x) => x.code)).toEqual(["I2"]);
  });

  it("better-specs: rating >= source, unrated dropped, rating desc then price asc", () => {
    expect(rankAlternatives(source, pool, "better-specs", 10).map((x) => x.code)).toEqual(["A5", "A2", "A7", "A6"]);
  });

  it("better-specs with an unrated source keeps everything, rated first", () => {
    expect(rankAlternatives({ ...source, rating: undefined }, pool, "better-specs", 3).map((x) => x.code)).toEqual(["A5", "A2", "A7"]);
  });

  it("applies limit and de-duplicates", () => {
    expect(rankAlternatives(source, [...pool, pool[1]], "cheaper", 2)).toHaveLength(2);
    expect(rankAlternatives(source, [pool[1], pool[1]], undefined, 10)).toHaveLength(1);
  });
});

describe("parsing helpers", () => {
  it("extracts the commodity id from a product URL", () => {
    expect(commodityIdFromUrl("https://www.alza.cz/iphone-17-256gb-levandulova-d13078769.htm")).toBe(13078769);
    expect(commodityIdFromUrl("https://www.alza.cz/foo.htm")).toBeUndefined();
  });

  it("maps the live alternatives envelope and skips malformed rows", () => {
    const raw = {
      total: 3,
      data: [
        { id: 13078769, code: "RI054b5", name: "iPhone 17 256GB", url: "https://www.alza.cz/x-d13078769.htm", priceNoCurrency: 25990, rating: 4.8, avail: "Skladem > 5 ks", img: "i.jpg" },
        { code: "", name: "no code" },
        null,
        { id: "9", code: "ZZ", name: "No rating", priceNoCurrency: 100, rating: 0 },
      ],
    };
    const out = parseAlternatives(raw, "CZK");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ code: "RI054b5", id: 13078769, price: 25990, rating: 4.8, availability: "in stock", availabilityText: "Skladem > 5 ks", currency: "CZK" });
    expect(out[1]).toMatchObject({ id: 9, rating: undefined });
    expect(parseAlternatives({}, "CZK")).toEqual([]);
  });

  it("matches brands diacritic- and case-insensitively", () => {
    expect(matchesBrand(p("B", "ŠKODA Kodiaq", 1), "Skoda")).toBe(true);
    expect(matchesBrand(p("B", "X", 1, undefined, { brand: "apple" }), "Apple")).toBe(true);
  });
});

describe("Alternatives.recommend", () => {
  const raw = (rows: unknown[]) => ({ data: rows });
  const row = (x: Product) => ({ id: x.id, code: x.code, name: x.name, url: x.url, priceNoCurrency: x.price, rating: x.rating });

  it("uses Alza's list keyed by the numeric id from the URL", async () => {
    const alternatives = vi.fn().mockResolvedValue(raw(pool.map(row)));
    const catalog = { getProduct: vi.fn().mockResolvedValue({ ...source, id: 0, url: "https://www.alza.cz/x-d13078770.htm" }), searchProducts: vi.fn() };
    const res = await new Alternatives(catalog as never, { alternatives }).recommend({ code: "A1", mode: "cheaper", limit: 2 });
    expect(alternatives).toHaveBeenCalledWith(13078770);
    expect(res.poolSource).toBe("alza-alternatives");
    expect(res.alternatives.map((x) => x.code)).toEqual(["A7", "A4"]);
    expect(catalog.searchProducts).not.toHaveBeenCalled();
  });

  it("falls back to a same-category search when the list is empty or the endpoint fails", async () => {
    for (const alt of [vi.fn().mockResolvedValue(raw([])), vi.fn().mockRejectedValue(new Error("HTTP 500"))]) {
      const searchProducts = vi.fn().mockResolvedValue({ query: "", total: 3, page: 1, pageSize: 3, products: pool });
      const catalog = { getProduct: vi.fn().mockResolvedValue({ ...source, category: "Mobilní telefony" }), searchProducts };
      const res = await new Alternatives(catalog as never, { alternatives: alt }).recommend({ code: "A1", mode: "same-brand" });
      expect(res.poolSource).toBe("category-search");
      expect(searchProducts.mock.calls[0][0].query).toBe("Apple Mobilní telefony");
      expect(res.alternatives.map((x) => x.code)).toEqual(["A5", "A2", "A6"]);
    }
  });
});
