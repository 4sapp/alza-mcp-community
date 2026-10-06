import type { Product } from "./types.js";

/**
 * Sale detection from Alza listing cards (live-verified 2026-10-06 on alza.cz).
 *
 * There is no "Akce" facet (see docs/gap-analysis.md) and the sale landing
 * pages (/vyprodej -> /mega-slevy/y842.htm, /zbozi-z-druhe-ruky) are
 * marketing hubs with no product grid. Discounts are visible on ordinary
 * category listing cards (`/{categoryId}.htm`) in the price box in two forms:
 *
 *  - `.ads-pb__original-price--strike` — the crossed-out original price
 *    (e.g. "15 390,-" next to the current "12 490,-"; header "Zlevněno -18 %").
 *  - `.ads-pb__original-price` without `--strike` — a savings amount
 *    ("Ušetříte 100,-"), so original = current + savings.
 *
 * The discount % is always computed from these observed prices; the header
 * badge ("Zlevněno -18 %", "Super cena", "Cenová bomba") is never trusted.
 * Czech-only: the savings wording and price format ("N,-") are CZ-specific.
 */
export interface RawDealCard {
  priceText: string | null;
  originalPriceText: string | null;
  originalIsStrike: boolean;
}

export interface Deal extends Product {
  price: number;
  originalPrice: number;
  savings: number;
  discountPercent: number;
}

/** Leaf categories scanned when no `category_id` is given (alza.cz, verified 2026-10-06). */
export const DEFAULT_DEAL_CATEGORIES: ReadonlyArray<{ id: number; name: string }> = [
  { id: 18843445, name: "Mobilní telefony" },
  { id: 18842920, name: "Notebooky" },
  { id: 18842948, name: "Monitory" },
  { id: 18849604, name: "Televize" },
  { id: 18843602, name: "Sluchátka" },
];

export function parseCzPrice(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/ /g, " ").match(/(\d[\d\s]*?)\s*,-/);
  if (!m) return undefined;
  const n = Number((m[1] ?? "").replace(/\s+/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Resolve current/original price from observed card text; undefined when the card is not discounted. */
export function computeDeal(card: RawDealCard): { price: number; originalPrice: number; savings: number; discountPercent: number } | undefined {
  const price = parseCzPrice(card.priceText);
  if (price === undefined || !card.originalPriceText) return undefined;
  const orig = parseCzPrice(card.originalPriceText);
  if (orig === undefined) return undefined;
  const originalPrice = card.originalIsStrike ? orig : price + orig;
  if (originalPrice <= price) return undefined;
  const savings = originalPrice - price;
  const discountPercent = Math.round((savings / originalPrice) * 1000) / 10;
  return { price, originalPrice, savings, discountPercent };
}

export function compareDeals(a: Deal, b: Deal): number {
  return b.discountPercent - a.discountPercent || b.savings - a.savings;
}
