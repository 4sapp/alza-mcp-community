import { describe, expect, it } from "vitest";
import { compareForSort } from "../src/domain/catalog.js";
import type { Product } from "../src/domain/types.js";

const p = (over: Partial<Product>): Product => ({
  code: "X1",
  id: 1,
  name: "p",
  url: "https://www.alza.cz/x.htm",
  currency: "CZK",
  ...over,
});

describe("compareForSort", () => {
  it("sorts price-asc ascending, missing prices last", () => {
    const items = [p({ code: "A", price: 300 }), p({ code: "B" }), p({ code: "C", price: 100 })];
    const sorted = [...items].sort((a, b) => compareForSort(a, b, "price-asc"));
    expect(sorted.map((x) => x.code)).toEqual(["C", "A", "B"]);
  });

  it("sorts price-desc descending, missing prices last", () => {
    const items = [p({ code: "A", price: 300 }), p({ code: "B" }), p({ code: "C", price: 100 })];
    const sorted = [...items].sort((a, b) => compareForSort(a, b, "price-desc"));
    expect(sorted.map((x) => x.code)).toEqual(["A", "C", "B"]);
  });

  it("sorts rating descending, missing ratings last", () => {
    const items = [p({ code: "A", rating: 4.2 }), p({ code: "B" }), p({ code: "C", rating: 4.9 })];
    const sorted = [...items].sort((a, b) => compareForSort(a, b, "rating"));
    expect(sorted.map((x) => x.code)).toEqual(["C", "A", "B"]);
  });

  it("leaves order untouched for relevance/newest/undefined", () => {
    const items = [p({ code: "A", price: 300 }), p({ code: "B", price: 100 })];
    for (const sort of ["relevance", "newest", undefined] as const) {
      const sorted = [...items].sort((a, b) => compareForSort(a, b, sort));
      expect(sorted.map((x) => x.code)).toEqual(["A", "B"]);
    }
  });

  it("is antisymmetric on a mixed sample", () => {
    const items = [
      p({ code: "A", price: 139, rating: 4.5 }),
      p({ code: "B", price: 209, rating: 4.7 }),
      p({ code: "C", price: 169 }),
    ];
    for (const sort of ["price-asc", "price-desc", "rating"] as const) {
      const c = (a: Product, b: Product) => compareForSort(a, b, sort);
      for (const a of items) {
        for (const b of items) {
          if (a === b) continue;
          expect(Math.sign(c(a, b))).toBe(-Math.sign(c(b, a)));
        }
      }
    }
  });
});
