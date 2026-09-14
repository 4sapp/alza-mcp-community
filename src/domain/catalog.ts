import type { AlzaBrowser } from "../infra/browser.js";
import { TtlCache } from "../infra/cache.js";
import { NotFoundError } from "../infra/errors.js";
import { extractJsonLd, findProduct as findJsonLdProduct } from "../infra/jsonld.js";
import { log } from "../infra/logger.js";
import type { Category, Product, SearchResult } from "./types.js";

export type SortOrder = "relevance" | "price-asc" | "price-desc" | "rating" | "newest";

export interface SearchOptions {
  query: string;
  limit?: number;
  page?: number;
  sort?: SortOrder;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  categoryId?: number;
}

interface RawCard {
  code: string | null;
  id: string | null;
  sponsored: boolean;
  name: string | null;
  url: string | null;
  image: string | null;
  priceText: string | null;
  ratingText: string | null;
  reviewCountText: string | null;
  /**
   * Purchasable right now, per the card's CTA (verified 2026-09-12):
   * true = "Do košíku" / "Vybrat variantu" button, false = "Hlídat" (watch)
   * button, null = no CTA found (undetermined). Alza search cards carry no
   * explicit stock attribute.
   */
  inStock: boolean | null;
}

const CARD_EXTRACTOR = `(function() {
  return Array.from(document.querySelectorAll('.browsingitem')).map(function(card) {
    function txt(sel) {
      var el = card.querySelector(sel);
      return el ? el.textContent.trim().replace(/\\s+/g, ' ') : null;
    }
    function attr(sel, a) {
      var el = card.querySelector(sel);
      return el ? el.getAttribute(a) : null;
    }
    var sample = (card.textContent || '').trim().replace(/\\s+/g, ' ');
    var ratingMatch = sample.match(/(\\d[,.]\\d)\\s*\\d+×/);
    var reviewMatch = sample.match(/(\\d+)×/);
    // Stock signal = the purchase CTA (verified 2026-09-12): "Do košíku" /
    // "Vybrat variantu" = purchasable now, a standalone "Hlídat" button = not
    // purchasable. The "Hlídat dostupnost nebo cenu" watch link appears on
    // every card, so only exact CTA texts are trusted.
    var inStock = null;
    var ctas = Array.from(card.querySelectorAll('a, button')).map(function(e) { return (e.textContent || '').replace(/\\u00a0/g, ' ').trim(); });
    if (ctas.some(function(t) { return /Do košíku|Vybrat variantu/.test(t); })) inStock = true;
    else if (ctas.some(function(t) { return t === 'Hlídat'; })) inStock = false;
    return {
      code: card.getAttribute('data-code'),
      id: card.getAttribute('data-id'),
      sponsored: !!card.querySelector('.box-recommendation'),
      name: txt('a.name') || txt('.name'),
      url: attr('a.name', 'href') || attr('a[href*=".htm"]', 'href'),
      image: attr('img', 'src') || attr('img', 'data-src'),
      priceText: txt('.price'),
      ratingText: ratingMatch ? ratingMatch[1] : null,
      reviewCountText: reviewMatch ? reviewMatch[1] : null,
      inStock: inStock
    };
  });
})()`;

const PRODUCT_PAGE_EXTRACTOR = `(function() {
  var lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(function(s) {
    try { return JSON.parse(s.textContent || '{}'); } catch (e) { return null; }
  }).filter(Boolean);
  function findType(t) {
    for (var i = 0; i < lds.length; i++) {
      var b = lds[i];
      if (!b) continue;
      var bt = b['@type'];
      if (bt === t) return b;
      if (Array.isArray(bt) && bt.indexOf(t) >= 0) return b;
      if (b['@graph']) {
        for (var j = 0; j < b['@graph'].length; j++) {
          var g = b['@graph'][j];
          if (g && (g['@type'] === t || (Array.isArray(g['@type']) && g['@type'].indexOf(t) >= 0))) return g;
        }
      }
    }
    return null;
  }
  return {
    title: document.title,
    url: location.href,
    h1: (document.querySelector('h1') || {}).textContent || null,
    product: findType('Product'),
    breadcrumb: findType('BreadcrumbList'),
    params: Array.from(document.querySelectorAll('.paramTbl tr, table.paramTbl tr, .productSpecBox tr')).slice(0, 30).map(function(tr) {
      var th = tr.querySelector('th'), td = tr.querySelector('td');
      return { name: th ? th.textContent.trim().replace(/\\s+/g,' ') : '', value: td ? td.textContent.trim().replace(/\\s+/g,' ') : '' };
    }).filter(function(p) { return p.name && p.value; })
  };
})()`;

export class Catalog {
  private readonly searchCache = new TtlCache<string, SearchResult>(60 * 1000);
  private readonly productCache = new TtlCache<string, Product>(15 * 60 * 1000);
  private readonly productUrlCache = new TtlCache<string, string>(60 * 60 * 1000);
  private readonly categoryCache = new TtlCache<number, Category[]>(24 * 60 * 60 * 1000);

  constructor(private readonly browser: AlzaBrowser) {}

  async searchProducts(opts: SearchOptions): Promise<SearchResult> {
    const limit = clamp(opts.limit ?? 20, 1, 50);
    const page = Math.max(1, opts.page ?? 1);
    const cacheKey = JSON.stringify({ ...opts, limit, page });

    // Alza's search page ignores server-side sort (verified 2026-09-12) and
    // cards carry no explicit stock attribute, so for price/rating orders we
    // gather candidates from up to sortSweepPages(limit) pages and sort
    // client-side (compareForSort); `in_stock` is enforced from each card's
    // purchase CTA (see RawCard.inStock). An explicit page > 1 keeps the
    // single-page behaviour.
    const sweeping =
      page === 1 &&
      (opts.sort === "price-asc" || opts.sort === "price-desc" || opts.sort === "rating");
    const maxPages = sweeping ? sortSweepPages(limit) : 1;

    return this.searchCache.memoize(cacheKey, async () => {
      const candidates: Product[] = [];
      const seen = new Set<string>();
      let pagesFetched = 0;
      for (let pageNum = page; pageNum < page + maxPages; pageNum++) {
        const cards = await this.fetchSearchPage(opts, pageNum);
        pagesFetched++;
        const organic = cards
          .filter((c) => !c.sponsored)
          .map((c) => this.normalizeCard(c))
          .filter((p): p is Product => p !== null);
        for (const p of organic) {
          if (seen.has(p.code)) continue;
          seen.add(p.code);
          candidates.push(p);
          this.productUrlCache.set(p.code, p.url);
        }
        // Ran past the end of the results (empty/short page) — no point more.
        if (!sweeping || organic.length === 0) break;
      }

      const products = candidates
        .filter((p) => filterByPrice(p, opts))
        .filter((p) => passesInStock(p, opts.inStock))
        .sort((a, b) => compareForSort(a, b, opts.sort))
        .slice(0, limit);

      log.debug("catalog.searchProducts", {
        query: opts.query,
        pages: pagesFetched,
        candidates: candidates.length,
        returned: products.length,
      });

      return {
        query: opts.query,
        total: products.length,
        page,
        pageSize: limit,
        candidatesScanned: candidates.length,
        products,
      };
    });
  }

  private async fetchSearchPage(opts: SearchOptions, pageNum: number): Promise<RawCard[]> {
    const url = this.buildSearchUrl(opts, pageNum);
    log.debug("catalog.fetchSearchPage", { url });
    return this.browser.withPage(async (p) => {
      const res = await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
      await p.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
      if (res && res.status() >= 400) {
        // Some "no results" pages are legit 404 — degrade gracefully.
        return [] as RawCard[];
      }
      // Render-race guard (observed 2026-09-12): the first navigation after a
      // cold browser launch can finish "load" with the result grid still
      // unrendered, and the selector wait can expire with zero cards —
      // reporting "No products found" for a query that does have results.
      // Retry the extraction a bounded number of times before accepting an
      // empty grid (a genuinely empty result costs ~30 s extra; a false
      // empty is much worse).
      for (let attempt = 0; ; attempt++) {
        await p.waitForSelector(".browsingitem", { timeout: 10_000 }).catch(() => null);
        const cards = (await p.evaluate(CARD_EXTRACTOR)) as RawCard[];
        if (cards.length > 0 || attempt >= 2) return cards;
        await p.waitForTimeout(2_000);
      }
    });
  }

  async getProduct(code: string): Promise<Product> {
    const trimmed = code.trim();
    if (!trimmed) throw new NotFoundError("product code");

    return this.productCache.memoize(trimmed, async () => {
      const url = await this.resolveProductUrl(trimmed);
      log.debug("catalog.getProduct", { code: trimmed, url });

      const data = await this.browser.withPage(async (p) => {
        await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
        await p.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
        return (await p.evaluate(PRODUCT_PAGE_EXTRACTOR)) as ProductPageData;
      });

      const ld = data.product;
      if (!ld) throw new NotFoundError(`product ${trimmed}`);

      const name = (ld.name as string) ?? data.h1 ?? trimmed;
      const offers = pickOffer(ld.offers);
      const rating = pickRating(ld.aggregateRating);
      const breadcrumbs = pickBreadcrumbs(data.breadcrumb);
      const images = pickImages(ld.image);

      return {
        code: ((ld.sku as string) ?? trimmed).trim(),
        id: 0,
        name: stripHtmlEntities(name),
        url: data.url,
        image: images[0],
        price: offers.price,
        currency: offers.priceCurrency ?? this.browser.locale.currency,
        availability: offers.availability,
        rating: rating.average,
        brand: pickBrand(ld.brand),
        category: breadcrumbs[breadcrumbs.length - 2],
        params: data.params.length > 0 ? data.params : undefined,
      };
    });
  }

  async listCategories(parentId?: number): Promise<Category[]> {
    return this.categoryCache.memoize(parentId ?? 0, async () => {
      const url = parentId
        ? `${this.browser.locale.baseUrl}/${parentId}.htm`
        : this.browser.locale.baseUrl;

      return this.browser.withPage(async (p) => {
        await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
        await p.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});

        const raw = (await p.evaluate(`(function() {
          // Top-level: Alza homepage uses MUI list items with class
          // 'category-navigation-item'. Sub-level: same pattern works
          // on category pages, with sidebar links also marked similarly.
          var sels = [
            'li[class*="category-naviga"] a[href*=".htm"]',
            '.subCategoriesList a[href*=".htm"]',
            '.category-tree a[href*=".htm"]',
            'ul.subCategories a[href*=".htm"]'
          ];
          var seen = new Set();
          var out = [];
          for (var s = 0; s < sels.length; s++) {
            var els = document.querySelectorAll(sels[s]);
            for (var i = 0; i < els.length; i++) {
              var a = els[i];
              var href = a.getAttribute('href') || '';
              var idMatch = href.match(/(\\d{4,})\\.htm/);
              var name = (a.textContent || '').trim().replace(/\\s+/g, ' ');
              if (!idMatch || !name || name.length > 80) continue;
              // Skip promo/seasonal entries that appear at the top of the menu.
              if (/^Alza dny/i.test(name)) continue;
              var id = parseInt(idMatch[1], 10);
              if (seen.has(id)) continue;
              seen.add(id);
              out.push({ id: id, name: name, url: href });
            }
            if (out.length > 0) break;
          }
          return out;
        })()`)) as Array<{ id: number; name: string; url: string }>;

        return raw
          .map((c) => ({
            id: c.id,
            name: stripHtmlEntities(c.name),
            url: this.absUrl(c.url),
          }))
          .slice(0, 60);
      });
    });
  }

  async resolveProductUrl(code: string): Promise<string> {
    const cached = this.productUrlCache.get(code);
    if (cached) return cached;

    // Search by code, expect first matching card.
    const searchUrl = this.buildSearchUrl({ query: code }, 1);
    const found = await this.browser.withPage(async (p) => {
      await p.goto(searchUrl, { waitUntil: "commit", timeout: 30_000 });
      await p.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
      await p.waitForSelector(".browsingitem", { timeout: 12_000 }).catch(() => null);
      return (await p.evaluate(`(function() {
        var cards = Array.from(document.querySelectorAll('.browsingitem'));
        for (var i = 0; i < cards.length; i++) {
          var c = cards[i];
          var dc = (c.getAttribute('data-code') || '').toLowerCase();
          if (dc !== ${JSON.stringify(code.toLowerCase())}) continue;
          var a = c.querySelector('a.name') || c.querySelector('a[href*=".htm"]');
          if (a && a.href) return a.href;
        }
        return null;
      })()`)) as string | null;
    });

    if (!found) throw new NotFoundError(`product ${code}`);
    this.productUrlCache.set(code, found);
    return found;
  }

  private buildSearchUrl(opts: SearchOptions, page: number): string {
    const url = new URL("/search.htm", this.browser.locale.baseUrl);
    url.searchParams.set("exps", opts.query);
    if (opts.sort) {
      // NOTE: Alza's /search.htm currently ignores the `o=` sort parameter
      // (verified 2026-09-12: o=0/2/3 all return identical relevance order;
      // the site's sort control is client-side JS). We keep the parameter as
      // documentation of intent and rely on `compareForSort` below, which
      // sorts the fetched page client-side — that is the actual guarantee.
      const sortMap: Record<SortOrder, string> = {
        relevance: "0",
        "price-asc": "2",
        "price-desc": "3",
        rating: "8",
        newest: "9",
      };
      url.searchParams.set("o", sortMap[opts.sort] ?? "0");
    }
    if (page > 1) url.searchParams.set("pg", String(page));
    if (opts.categoryId) url.searchParams.set("idc", String(opts.categoryId));
    return url.toString();
  }

  private normalizeCard(c: RawCard): Product | null {
    if (!c.code || !c.name || !c.url) return null;
    return {
      code: c.code,
      id: c.id ? Number(c.id) : 0,
      name: c.name,
      url: this.absUrl(c.url),
      image: c.image ?? undefined,
      price: parsePrice(c.priceText),
      currency: this.browser.locale.currency,
      availability:
        c.inStock === null ? undefined : c.inStock ? "in stock" : "not purchasable now",
      rating: c.ratingText ? Number(c.ratingText.replace(",", ".")) : undefined,
    };
  }

  private absUrl(url: string): string {
    if (url.startsWith("http")) return url;
    return new URL(url, this.browser.locale.baseUrl).toString();
  }
}

interface ProductPageData {
  title: string;
  url: string;
  h1: string | null;
  product: Record<string, unknown> | null;
  breadcrumb: Record<string, unknown> | null;
  params: Array<{ name: string; value: string }>;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * How many result pages to gather before a client-side price/rating sort.
 * Alza serves ~24 cards per page (verified 2026-09-12). Two pages (~48
 * candidates) is the floor so the sort has real material; three pages (~72)
 * covers the largest limit. Bounded for latency: each page is one full
 * browser navigation.
 */
export function sortSweepPages(limit: number): number {
  return Math.min(3, Math.max(2, Math.ceil(limit / 24)));
}

/**
 * In-stock filter from the card's purchase CTA. `inStock: true` keeps only
 * products confirmed purchasable now; undetermined stock is excluded (the
 * flag is an assertion). Without the flag nothing is filtered.
 */
export function passesInStock(p: Product, inStock?: boolean): boolean {
  if (!inStock) return true;
  return p.availability === "in stock";
}

/**
 * Client-side sort for search results. Alza's search page serves results in
 * relevance order regardless of the `o=` parameter, so price/rating orders
 * are applied here — to the swept candidate pool for price/rating orders
 * (see sortSweepPages), never to the whole catalog. Products without a
 * price sort last for price orders; missing ratings sort last for rating order.
 */
export function compareForSort(a: Product, b: Product, sort?: SortOrder): number {
  if (sort === "price-asc" || sort === "price-desc") {
    if (a.price === undefined && b.price === undefined) return 0;
    if (a.price === undefined) return 1; // unknown price sorts last
    if (b.price === undefined) return -1;
    return sort === "price-asc" ? a.price - b.price : b.price - a.price;
  }
  if (sort === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
  return 0;
}

function filterByPrice(p: Product, opts: SearchOptions): boolean {
  if (opts.minPrice !== undefined && (p.price ?? Infinity) < opts.minPrice) return false;
  if (opts.maxPrice !== undefined && (p.price ?? -Infinity) > opts.maxPrice) return false;
  return true;
}

function parsePrice(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  // Alza search cards show prices like "5 290,-" or "Super cena 4 399,- Ušetříte 91,-".
  // Take the first price-shaped number.
  const m = raw.match(/(\d[\d\s]{1,7})\s*,-/);
  if (!m) return undefined;
  const cleaned = (m[1] ?? "").replace(/\s+/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function pickOffer(raw: unknown): { price?: number; priceCurrency?: string; availability?: string } {
  if (!raw || typeof raw !== "object") return {};
  const first = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
  const price = first["price"] ?? (first["priceSpecification"] as Record<string, unknown> | undefined)?.["price"];
  return {
    price: asNumber(price),
    priceCurrency: asString(first["priceCurrency"]),
    availability: stripSchema(asString(first["availability"])),
  };
}

function pickRating(raw: unknown): { average?: number; count?: number } {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return {
    average: asNumber(r["ratingValue"]),
    count: asNumber(r["reviewCount"] ?? r["ratingCount"]),
  };
}

function pickBrand(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") return asString((raw as Record<string, unknown>)["name"]);
  return undefined;
}

function pickImages(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    return raw
      .map((i) => (typeof i === "string" ? i : asString((i as Record<string, unknown>)["url"])))
      .filter((u): u is string => !!u);
  }
  if (typeof raw === "object") {
    const u = asString((raw as Record<string, unknown>)["url"]);
    return u ? [u] : [];
  }
  return [];
}

function pickBreadcrumbs(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>)["itemListElement"];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => stripHtmlEntities(asString((item as Record<string, unknown>)["name"]) ?? ""))
    .filter(Boolean);
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function stripSchema(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.replace(/^https?:\/\/schema\.org\//, "");
}

function stripHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/g, "");
}
