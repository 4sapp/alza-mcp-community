import type { MobileApi } from "../infra/mobile-api.js";
import { NotFoundError } from "../infra/errors.js";
import { log } from "../infra/logger.js";
import type { Catalog } from "./catalog.js";
import type { Product } from "./types.js";

export type AlternativeMode = "cheaper" | "better-specs" | "same-brand";

export interface AlternativesResult {
  source: Product;
  mode?: AlternativeMode;
  /** Where the candidate pool came from: Alza's own list, or the same-category search fallback. */
  poolSource: "alza-alternatives" | "category-search";
  /** Candidates considered before the mode filter/ranking. */
  candidatesConsidered: number;
  alternatives: Product[];
}

/** Numeric commodity id (the `d########` suffix) from a product URL. */
export function commodityIdFromUrl(url: string): number | undefined {
  const m = /-d(\d+)\.htm/i.exec(url);
  return m ? Number(m[1]) : undefined;
}

/**
 * Maps the `/v1/alternatives/{id}` response (`data[]` of catalog commodity cards,
 * live-verified 2026-10-06) to Products. The cards carry no brand, so `brand`
 * stays unset here; same-brand matching falls back to the product name.
 */
export function parseAlternatives(raw: unknown, currency: string): Product[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: Product[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const code = typeof d.code === "string" ? d.code.trim() : "";
    const name = typeof d.name === "string" ? d.name.trim() : "";
    const url = typeof d.url === "string" ? d.url : "";
    if (!code || !name) continue;
    const id = typeof d.id === "number" ? d.id : Number(d.id) || commodityIdFromUrl(url) || 0;
    const price = typeof d.priceNoCurrency === "number" ? d.priceNoCurrency : undefined;
    out.push({
      code,
      id,
      name,
      url,
      image: typeof d.img === "string" ? d.img : undefined,
      price,
      currency,
      availability: typeof d.avail === "string" ? d.avail : undefined,
      rating: typeof d.rating === "number" && d.rating > 0 ? d.rating : undefined,
      category: typeof d.categoryName === "string" ? d.categoryName : undefined,
    });
  }
  return out;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

const words = (s: string): string[] => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Brand match. Alza's alternatives/search cards carry no brand field, and many
 * names omit it (live 2026-10-06: "iPhone 17 ..." for brand "Apple"), so a
 * candidate matches when its brand field equals the brand, the brand appears as
 * a whole word in its name, or its name opens with the same leading token as the
 * source name (Alza names lead with the brand or product line).
 */
export function matchesBrand(p: Product, brand: string, sourceName?: string): boolean {
  const b = words(brand);
  if (b.length === 0) return false;
  if (p.brand) return norm(p.brand).trim() === norm(brand).trim();
  const w = words(p.name);
  if (b.every((x) => w.includes(x))) return true;
  const lead = sourceName ? leadingWord(sourceName) : undefined;
  return lead !== undefined && leadingWord(p.name) === lead;
}

/**
 * First word of a name that is not purely numeric. Display names lead with the
 * screen diagonal (`34" AOC CU34G2XP`, `27" iiyama ProLite`), so the plain first
 * token is the size, not the brand, and would match every 34" product.
 */
function leadingWord(name: string): string | undefined {
  return words(name).find((x) => !/^\d+$/.test(x));
}

const byPriceAsc = (a: Product, b: Product): number =>
  (a.price ?? Infinity) - (b.price ?? Infinity);
const byRatingDesc = (a: Product, b: Product): number => (b.rating ?? -1) - (a.rating ?? -1);

/**
 * Ranking heuristics (documented in the tool description):
 * - cheaper: price strictly below the source; cheapest first (rating breaks ties).
 * - same-brand: brand matches the source (see matchesBrand); best rating first, then lower price.
 * - better-specs: rated at least as high as the source (unrated candidates are
 *   dropped when the source has a rating); best rating first, then lower price.
 *   Spec tables are not compared — use `get_product` params on the shortlist.
 * - no mode: Alza's own order is kept.
 * The source product is always excluded; products without a price are never "cheaper".
 */
export function rankAlternatives(source: Product, pool: Product[], mode: AlternativeMode | undefined, limit: number): Product[] {
  const seen = new Set<string>();
  const candidates = pool.filter((p) => {
    if (p.code === source.code || (source.id && p.id === source.id)) return false;
    if (seen.has(p.code)) return false;
    seen.add(p.code);
    return true;
  });
  let ranked: Product[];
  switch (mode) {
    case "cheaper":
      ranked = candidates
        .filter((p) => source.price !== undefined && p.price !== undefined && p.price < source.price)
        .sort((a, b) => byPriceAsc(a, b) || byRatingDesc(a, b));
      break;
    case "same-brand":
      ranked = source.brand
        ? candidates.filter((p) => matchesBrand(p, source.brand as string, source.name)).sort((a, b) => byRatingDesc(a, b) || byPriceAsc(a, b))
        : [];
      break;
    case "better-specs":
      ranked = candidates
        .filter((p) => (source.rating === undefined ? true : p.rating !== undefined && p.rating >= source.rating))
        .sort((a, b) => byRatingDesc(a, b) || byPriceAsc(a, b));
      break;
    default:
      ranked = candidates;
  }
  return ranked.slice(0, limit);
}

export class Alternatives {
  constructor(
    private readonly catalog: Catalog,
    private readonly api: Pick<MobileApi, "alternatives">,
  ) {}

  async recommend(opts: { code: string; mode?: AlternativeMode; limit?: number }): Promise<AlternativesResult> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
    const source = await this.catalog.getProduct(opts.code);
    const id = source.id || commodityIdFromUrl(source.url);
    if (!id) throw new NotFoundError(`commodity id for product ${opts.code}`);

    let pool: Product[] = [];
    try {
      pool = parseAlternatives(await this.api.alternatives(id), source.currency);
    } catch (err) {
      log.warn("alternatives endpoint failed, using category search", { error: err instanceof Error ? err.message : String(err) });
    }
    const hasOthers = (list: Product[]) => list.some((p) => p.code !== source.code);
    let poolSource: AlternativesResult["poolSource"] = "alza-alternatives";
    let ranked = hasOthers(pool) ? rankAlternatives(source, pool, opts.mode, limit) : [];

    if (ranked.length === 0) {
      const query = [opts.mode === "same-brand" ? source.brand : undefined, source.category ?? source.name.split(/\s+/).slice(0, 3).join(" ")]
        .filter(Boolean)
        .join(" ");
      const search = await this.catalog.searchProducts({ query, limit: 50 });
      pool = search.products;
      poolSource = "category-search";
      ranked = rankAlternatives(source, pool, opts.mode, limit);
    }
    return { source, mode: opts.mode, poolSource, candidatesConsidered: pool.length, alternatives: ranked };
  }
}
