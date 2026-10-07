import { describe, expect, it } from "vitest";
import { CARD_EXTRACTOR_FN, Catalog, NO_RESULTS_PROBE, shouldSweep } from "../src/domain/catalog.js";
import { availabilityFields, normalizeAvailability } from "../src/domain/availability.js";
import { sortReviewsNewestFirst } from "../src/domain/reviews.js";
import { findProductPrompt } from "../src/prompts/find-product.js";
import { dedupeCodes, createCompareProductsTool } from "../src/tools/compare-products.js";
import { createSearchProductsTool } from "../src/tools/search-products.js";
import { formatCategoryFilters, formatReviews, formatSearchResult } from "../src/tools/format.js";
import { resolveLocale } from "../src/infra/locale.js";
import type { AlzaBrowser } from "../src/infra/browser.js";
import type { Product, ProductReview } from "../src/domain/types.js";
import type { ToolDeps } from "../src/tools/types.js";

/** A search/browse card as the live page renders it (fields trimmed to what the extractor reads). */
function fakeCard(opts: { code: string; text: string; aria?: string }) {
  return {
    getAttribute: (a: string) => (a === "data-code" ? opts.code : a === "data-id" ? "1" : null),
    get textContent() {
      return opts.text;
    },
    querySelector: (sel: string) =>
      sel === ".star-rating-wrapper[aria-label]" && opts.aria
        ? { getAttribute: (a: string) => (a === "aria-label" ? opts.aria : null) }
        : null,
    querySelectorAll: () => [],
  };
}

function extract(cards: unknown[]): Array<{ ratingText: string | null; reviewCountText: string | null }> {
  const fn = new Function(`return (${CARD_EXTRACTOR_FN})`)() as (root: unknown) => Array<{ ratingText: string | null; reviewCountText: string | null }>;
  return fn({ querySelectorAll: () => cards });
}

describe("card rating extraction (#78: rating missed for 1000+ reviews)", () => {
  // Live 2026-10-07, kabel usb-c: "4,8 4 923×" — the thousands separator broke `\d+×`.
  it("reads the rating when the review count has a thousands separator", () => {
    const [c] = extract([fakeCard({ code: "APWCB119o", text: "10 variant 4,8 4 923× Přidat do oblíbených AlzaPower Core" })]);
    expect(c!.ratingText).toBe("4,8");
    expect(c!.reviewCountText).toBe("4923");
  });

  it("prefers the star block's aria-label (CZ and SK wording)", () => {
    const cz = extract([fakeCard({ code: "A", text: "no rating text", aria: "Hodnocení: 4,6 z 5 na základě 1897 recenzí" })]);
    const sk = extract([fakeCard({ code: "B", text: "x", aria: "Hodnotenie: 4,5 z 5 na základe 12 recenzií" })]);
    expect(cz[0]!.ratingText).toBe("4,6");
    expect(sk[0]!.ratingText).toBe("4,5");
  });

  it("still reads small counts", () => {
    expect(extract([fakeCard({ code: "C", text: "4,7 12× foo" })])[0]!.ratingText).toBe("4,7");
  });
});

const prod = (over: Partial<Product>): Product => ({ code: "X", id: 1, name: "p", url: "https://www.alza.cz/x-d1.htm", currency: "CZK", ...over });

interface FakeOpts {
  cardsPerPage?: number;
  pages?: number;
  noResults?: boolean;
}

function fakeBrowser(opts: FakeOpts = {}) {
  const gotos: string[] = [];
  let selectorWaits = 0;
  const perPage = opts.cardsPerPage ?? 3;
  const browser = {
    locale: resolveLocale("https://www.alza.cz"),
    async withPage<T>(fn: (p: unknown) => Promise<T>): Promise<T> {
      let current = "";
      const page = {
        goto: async (url: string) => {
          gotos.push(url);
          current = url;
          return { status: () => 200 };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => {
          selectorWaits++;
          return null;
        },
        waitForTimeout: async () => {},
        evaluate: async (script: string) => {
          if (script === NO_RESULTS_PROBE) return opts.noResults === true;
          if (script.includes("querySelectorAll('.browsingitem')")) {
            const pageNo = Number(/-p(\d+)\.htm/.exec(current)?.[1] ?? 1);
            return Array.from({ length: perPage }, (_, i) => ({
              code: `P${pageNo}_${i}`,
              id: String(pageNo * 100 + i),
              sponsored: false,
              name: `Product ${pageNo}-${i}`,
              url: `/p${pageNo}-${i}-d${pageNo * 100 + i}.htm`,
              image: null,
              priceText: `${(pageNo * 100 + i) * 10},-`,
              ratingText: null,
              reviewCountText: null,
              inStock: true,
            }));
          }
          if (script.includes("-p(")) {
            // PAGE_URLS_EXTRACTOR: pages 2..N are linked.
            const out: Record<string, string> = {};
            for (let n = 2; n <= (opts.pages ?? 3); n++) out[String(n)] = `/q/18842920-p${n}.htm`;
            out["1"] = "/q/18842920.htm";
            return out;
          }
          return {};
        },
      };
      return fn(page);
    },
  };
  return { browser: browser as unknown as AlzaBrowser, gotos, selectorWaits: () => selectorWaits };
}

describe("search_products input handling (#78)", () => {
  it("rejects min_price > max_price before any request", async () => {
    const { browser, gotos } = fakeBrowser();
    await expect(new Catalog(browser).searchProducts({ query: "monitor", minPrice: 9000, maxPrice: 3000 })).rejects.toThrow(/min_price .* greater than max_price/);
    expect(gotos).toEqual([]);
  });

  it("rejects a blank query in the domain and trims it in the tool schema", async () => {
    const { browser, gotos } = fakeBrowser();
    await expect(new Catalog(browser).searchProducts({ query: "   " })).rejects.toThrow(/query must not be blank/);
    expect(gotos).toEqual([]);

    let schema: Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }> = {};
    const server = {
      registerTool: (_n: string, cfg: { inputSchema: typeof schema }) => {
        schema = cfg.inputSchema;
        return {};
      },
    };
    createSearchProductsTool({} as ToolDeps).register(server as never, (async () => ({})) as never);
    expect(schema.query!.safeParse("   ").success).toBe(false);
    expect(schema.query!.safeParse("  myš ").data).toBe("myš");
  });

  it("sweeps several pages when a price bound is set, and reports the real page capacity", async () => {
    const { browser, gotos } = fakeBrowser({ cardsPerPage: 3, pages: 3 });
    const res = await new Catalog(browser).searchProducts({ query: "myš", limit: 50, minPrice: 1500 });
    // Without a sweep only page 1 (3 cards) would be scanned.
    expect(res.candidatesScanned).toBe(9);
    expect(gotos.length).toBeGreaterThan(1);
    expect(res.pageSize).toBe(3); // the real cards-per-page, not the requested limit of 50
    expect(res.products.every((p) => (p.price ?? 0) >= 1500)).toBe(true);
    expect(res.hasMore).toBe(false);
  });

  it("reports hasMore/nextPage when Alza renders further pages", async () => {
    const { browser } = fakeBrowser({ cardsPerPage: 2, pages: 5 });
    const res = await new Catalog(browser).searchProducts({ query: "myš", limit: 5 });
    expect(res.pageSize).toBe(2);
    expect(res.hasMore).toBe(true);
    expect(res.nextPage).toBe(2);
    expect(formatSearchResult(res)).toContain("pass page=2");
  });

  it("shouldSweep: price bound or price/rating sort on page 1 only", () => {
    expect(shouldSweep({ minPrice: 1 }, 1)).toBe(true);
    expect(shouldSweep({ maxPrice: 1 }, 1)).toBe(true);
    expect(shouldSweep({ sort: "rating" }, 1)).toBe(true);
    expect(shouldSweep({ minPrice: 1 }, 2)).toBe(false);
    expect(shouldSweep({}, 1)).toBe(false);
  });
});

describe("no-result detection (#78)", () => {
  it("returns immediately on Alza's no-results page instead of waiting out the render retries", async () => {
    const { browser, selectorWaits } = fakeBrowser({ noResults: true });
    const res = await new Catalog(browser).searchProducts({ query: "xqzvbnmwq123" });
    expect(res.products).toEqual([]);
    expect(res.candidatesScanned).toBe(0);
    expect(selectorWaits()).toBe(0); // no 10 s selector wait x3
  });

  it("the probe matches the CZ/SK sentences and needs zero cards", () => {
    const run = (text: string, cards: boolean) => {
      const document = { querySelector: () => (cards ? {} : null), body: { innerText: text } };
      return new Function("document", `return ${NO_RESULTS_PROBE}`)(document);
    };
    expect(run("Ať hledám jak hledám, „xq“ jsem nenašel. Jak dál?", false)).toBe(true);
    expect(run("Nech hľadám ako hľadám, „xq“ som nenašiel. Ako ďalej?", false)).toBe(true);
    expect(run("Vyhledáno: myš 1 234 produktů", false)).toBe(false);
    expect(run("jsem nenašel", true)).toBe(false);
  });
});

describe("product id and availability (#78)", () => {
  function productBrowser(availability: unknown, url = "https://www.alza.cz/34-aoc-cu34g4-d13041832.htm?o=1") {
    const page = {
      goto: async () => null,
      waitForLoadState: async () => {},
      waitForSelector: async () => null,
      url: () => url,
      evaluate: async (script: string) => {
        if (script.includes("data-code")) return url;
        return {
          title: "t",
          url,
          h1: "t",
          product: { name: "AOC", sku: "WK243x56", offers: { price: 7187, priceCurrency: "CZK", availability } },
          breadcrumb: null,
          params: [],
        };
      },
    };
    return { locale: { baseUrl: "https://www.alza.cz", currency: "CZK" }, withPage: async <T>(fn: (p: typeof page) => Promise<T>) => fn(page) } as unknown as AlzaBrowser;
  }

  it("get_product derives the numeric id from the product URL instead of 0", async () => {
    const p = await new Catalog(productBrowser("https://schema.org/InStock")).getProduct("WK243x56");
    expect(p.id).toBe(13041832);
  });

  it("keeps 0 only when the URL carries no id", async () => {
    const p = await new Catalog(productBrowser("InStock", "https://www.alza.cz/plain")).getProduct("WK243x56");
    expect(p.id).toBe(0);
  });

  it("normalises schema.org tokens to the shared availability labels and keeps the raw text", async () => {
    const p = await new Catalog(productBrowser("https://schema.org/Discontinued")).getProduct("WK243x56");
    expect(p.availability).toBe("discontinued");
    expect(p.availabilityText).toBe("Discontinued");
  });

  it("maps tokens and CZ/SK display text onto one vocabulary", () => {
    expect(normalizeAvailability("InStock")).toBe("in stock");
    expect(normalizeAvailability("https://schema.org/OutOfStock")).toBe("out of stock");
    expect(normalizeAvailability("LimitedAvailability")).toBe("limited stock");
    expect(normalizeAvailability("PreOrder")).toBe("preorder");
    expect(normalizeAvailability("Skladem > 5 ks")).toBe("in stock");
    expect(normalizeAvailability("Skladom")).toBe("in stock");
    expect(normalizeAvailability("Není skladem")).toBe("out of stock");
    expect(normalizeAvailability("Vyřazeno z nabídky")).toBe("discontinued");
    expect(normalizeAvailability("")).toBeUndefined();
    expect(availabilityFields("Skladem > 5 ks")).toEqual({ availability: "in stock", availabilityText: "Skladem > 5 ks" });
    expect(availabilityFields("in stock")).toEqual({ availability: "in stock" });
    expect(availabilityFields("something odd")).toEqual({ availability: "something odd" });
  });
});

describe("compare_products (#78)", () => {
  it("de-duplicates case-insensitively and reports what was dropped", () => {
    expect(dedupeCodes(["WK243x56", " wk243x56", "AB1"])).toEqual({ codes: ["WK243x56", "AB1"], duplicates: ["wk243x56"] });
  });

  it("errors when fewer than 2 distinct codes remain, and notes ignored duplicates otherwise", async () => {
    let handler!: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
    const server = {
      registerTool: (_n: string, _c: unknown, h: typeof handler) => {
        handler = h;
        return {};
      },
    };
    const deps = {
      catalog: { getProduct: async (code: string) => prod({ code, name: code, price: 7187, brand: "AOC" }) },
    } as unknown as ToolDeps;
    createCompareProductsTool(deps).register(server as never, (async (_n: string, fn: () => Promise<unknown>) => fn()) as never);

    await expect(handler({ codes: ["WK243x56", "WK243x56"] }, {})).rejects.toThrow(/at least 2 distinct/);

    const ok = await handler({ codes: ["A1", "B2", "a1"] }, {});
    expect(ok.content[0]!.text).toContain("Duplicate codes ignored: a1.");
    expect(ok.structuredContent!.duplicatesIgnored).toEqual(["a1"]);
    // One shared price format (thousands separator) and a Brand row.
    expect(ok.content[0]!.text).toContain("7 187 CZK");
    expect(ok.content[0]!.text).toContain("| Brand | AOC | AOC |");
  });
});

describe("reviews (#78)", () => {
  const rv = (date: string | undefined, author: string): ProductReview => ({ author, date });

  it("orders newest first across storefront blocks and keeps undated reviews last", () => {
    const sorted = sortReviewsNewestFirst([rv("2026-09-28", "cz1"), rv("2025-10-27", "cz2"), rv("2026-10-04", "sk1"), rv(undefined, "nd"), rv("2026-09-07", "sk2")]);
    expect(sorted.map((r) => r.author)).toEqual(["sk1", "cz1", "sk2", "cz2", "nd"]);
  });

  it("says so when the list is longer than the aggregate count", () => {
    const text = formatReviews({ code: "X", ratingAverage: 4.9, reviewCount: 1, reviews: [rv("2026-01-01", "a"), rv("2026-01-02", "b")] });
    expect(text).toContain("more than the aggregate count of 1");
    expect(text).toContain("newest first");
    expect(formatReviews({ code: "X", reviewCount: 5, reviews: [rv("2026-01-01", "a")] })).not.toContain("aggregate count");
  });
});

describe("list_categories parentId (#78)", () => {
  function catBrowser() {
    const page = {
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {},
      evaluate: async () => [
        { id: 18842948, name: "LCD monitory", url: "/lcd-monitory/18842948.htm" },
        { id: 18876240, name: "Širokoúhlé monitory", url: "/sirokouhle-monitory/18876240.htm" },
      ],
    };
    return { locale: resolveLocale("https://www.alza.cz"), withPage: async <T>(fn: (p: typeof page) => Promise<T>) => fn(page) } as unknown as AlzaBrowser;
  }

  it("sub-level categories carry the requested parentId; the top level has none", async () => {
    const c = new Catalog(catBrowser());
    const sub = await c.listCategories(18842920);
    expect(sub.map((x) => x.parentId)).toEqual([18842920, 18842920]);
    const top = await new Catalog(catBrowser()).listCategories();
    expect(top.every((x) => x.parentId === undefined)).toBe(true);
  });
});

describe("list_category_filters caveat and find-product prompt (#78)", () => {
  it("flags checkbox groups as only partly honoured", () => {
    const text = formatCategoryFilters({
      categoryId: 1,
      brands: [],
      groups: [{ paramId: 36359, name: "Typ panelu", renderType: "Checkbox", filterable: true, filterMode: "value", values: [{ valueId: 1, description: "IPS" }] }],
    });
    expect(text).toContain("only honours values it has a landing page for");
  });

  it("find-product compares the shortlist with compare_products, not get_product per candidate", () => {
    const text = findProductPrompt.handler({ need: "monitor" }).messages[0]!.content.text;
    expect(text).toContain("compare_products");
    expect(text).toContain("recommend_alternatives");
    expect(text).not.toMatch(/call `get_product` for each/);
  });
});
