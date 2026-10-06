import { describe, expect, it, vi } from "vitest";
import { Reviews, commodityIdFromUrl, mapApiReview } from "../src/domain/reviews.js";
import { formatReviews } from "../src/tools/format.js";
import { OUTPUT_SCHEMAS } from "../src/tools/output-schemas.js";

// Shape captured live from webapi.alza.cz/api/catalog/commodities/{id}/reviews (2026-10-06);
// reviewer names anonymised, ids replaced.
const item = (over: Record<string, unknown> = {}) => ({
  rating: 5,
  likeCount: 1,
  description: "Velká spokojenost",
  positives: ["super cena"],
  negatives: [],
  name: "Jan, Testov",
  verifiedPurchase: true,
  reviewDetail: "Hodnoceno 12.09.2026, varianta Test Phone 128GB černá",
  images: [],
  ...over,
});

const aggregate = { average: 4.6, count: 250, reviews: [] as unknown[] };

function build(opts: { commodity: (id: number, o: { limit?: number; offset?: number }) => Promise<unknown>; url?: string; pageData?: unknown }) {
  const browser = {
    withPage: async (fn: (p: unknown) => Promise<unknown>) =>
      fn({
        goto: async () => {},
        waitForLoadState: async () => {},
        url: () => opts.url ?? "https://www.alza.cz/test?dq=111",
        evaluate: async () => opts.pageData ?? aggregate,
      }),
  };
  const catalog = { resolveProductUrl: async () => opts.url ?? "https://www.alza.cz/test?dq=111" };
  return new Reviews(browser as never, catalog as never, { commodityReviews: opts.commodity });
}

describe("commodityIdFromUrl", () => {
  it("parses -d####.htm and ?dq= forms", () => {
    expect(commodityIdFromUrl("https://www.alza.cz/x-d12999617.htm?o=1")).toBe(12999617);
    expect(commodityIdFromUrl("https://www.alza.cz/iphone-15?dq=7927612")).toBe(7927612);
    expect(commodityIdFromUrl("https://www.alza.cz/iphone-15")).toBeUndefined();
  });
});

describe("mapApiReview", () => {
  it("maps author, ISO date, rating, body, pros/cons and variant", () => {
    expect(mapApiReview(item({ negatives: ["nefunkční GPS"] }))).toEqual({
      author: "Jan, Testov",
      date: "2026-09-12",
      rating: 5,
      body: "Velká spokojenost",
      pros: ["super cena"],
      cons: ["nefunkční GPS"],
      verifiedPurchase: true,
      variant: "Test Phone 128GB černá",
      helpfulCount: 1,
    });
  });
  it("omits empty body and empty pros/cons", () => {
    const r = mapApiReview(item({ description: "", positives: [] }))!;
    expect(r.body).toBeUndefined();
    expect(r.pros).toBeUndefined();
    expect(r.cons).toBeUndefined();
  });
});

describe("Reviews.getProductReviews", () => {
  it("returns API reviews merged with the page aggregate and passes the schema", async () => {
    const commodity = vi.fn(async () => ({ items: [item(), item({ name: "Eva, Testov", rating: 1, description: "", positives: [], negatives: ["vada"] })], paging: {} }));
    const res = await build({ commodity }).getProductReviews("T1", 10);
    expect(commodity).toHaveBeenCalledWith(111, { limit: 10, offset: 0 });
    expect(res.ratingAverage).toBe(4.6);
    expect(res.reviewCount).toBe(250);
    expect(res.reviews).toHaveLength(2);
    expect(res.reviews[1].cons).toEqual(["vada"]);
    expect(OUTPUT_SCHEMAS.get_product_reviews.safeParse(res).success).toBe(true);
    const text = formatReviews(res);
    expect(text).toContain("Jan, Testov");
    expect(text).toContain("- vada");
  });

  it("paginates when the endpoint returns fewer than the limit and caps at limit", async () => {
    const commodity = vi.fn(async (_id: number, o: { limit?: number; offset?: number }) =>
      o.offset === 0
        ? { items: [item(), item()], paging: { next: {} } }
        : { items: [item(), item(), item()], paging: { next: {} } }
    );
    const res = await build({ commodity }).getProductReviews("T2", 4);
    expect(commodity).toHaveBeenCalledTimes(2);
    expect(commodity).toHaveBeenLastCalledWith(111, { limit: 2, offset: 2 });
    expect(res.reviews).toHaveLength(4);
  });

  it("falls back to aggregate-only without throwing when the endpoint fails", async () => {
    const commodity = vi.fn(async () => {
      throw new Error("HTTP 403");
    });
    const res = await build({ commodity }).getProductReviews("T3", 5);
    expect(res.reviews).toEqual([]);
    expect(res.ratingAverage).toBe(4.6);
  });

  it("does not cache the aggregate-only fallback after an endpoint failure", async () => {
    let fail = true;
    const commodity = vi.fn(async () => {
      if (fail) throw new Error("HTTP 503");
      return { items: [item()], paging: {} };
    });
    const reviews = build({ commodity });
    expect((await reviews.getProductReviews("T5", 5)).reviews).toEqual([]);
    fail = false;
    expect((await reviews.getProductReviews("T5", 5)).reviews).toHaveLength(1);
    expect(commodity).toHaveBeenCalledTimes(2);
    // A successful result is cached.
    await reviews.getProductReviews("T5", 5);
    expect(commodity).toHaveBeenCalledTimes(2);
  });

  it("falls back to aggregate-only when no commodity id can be derived", async () => {
    const commodity = vi.fn();
    const res = await build({ commodity, url: "https://www.alza.cz/plain" }).getProductReviews("T4", 5);
    expect(commodity).not.toHaveBeenCalled();
    expect(res.reviewCount).toBe(250);
  });
});
