/**
 * One availability vocabulary for every tool.
 *
 * Sources disagree about stock: search cards only know whether a purchase CTA
 * exists ("in stock" / "not purchasable now" — a watch button covers both
 * out-of-stock and discontinued), product pages carry a schema.org token
 * (`InStock`, `Discontinued`, …) and the alternatives pool carries Czech/Slovak
 * display text ("Skladem > 5 ks"). This maps the latter two onto the same
 * labels the card uses where they overlap, so a product reads the same in
 * `search_products`, `get_product`, `compare_products` and
 * `recommend_alternatives`. The raw upstream text is kept separately
 * (`Product.availabilityText`) when it differs from the label.
 */
export const AVAILABILITY_LABELS = [
  "in stock",
  "limited stock",
  "preorder",
  "out of stock",
  "discontinued",
  /** Card-only: the purchase CTA is missing, Alza does not say why. */
  "not purchasable now",
] as const;
export type AvailabilityLabel = (typeof AVAILABILITY_LABELS)[number];

const strip = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/**
 * Map a schema.org availability token/URL or Alza's CZ/SK availability text to
 * a label. Returns undefined when the text is empty or not recognised (the
 * caller then keeps the raw text).
 */
export function normalizeAvailability(raw: string | undefined | null): AvailabilityLabel | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const t = strip(raw.replace(/^https?:\/\/schema\.org\//i, ""));
  const compact = t.replace(/[^a-z]/g, "");
  switch (compact) {
    case "instock":
    case "onlineonly":
    case "instoreonly":
      return "in stock";
    case "limitedavailability":
      return "limited stock";
    case "preorder":
    case "presale":
    case "backorder":
      return "preorder";
    case "outofstock":
    case "soldout":
      return "out of stock";
    case "discontinued":
      return "discontinued";
    default:
      break;
  }
  // Display text. Negations first: "Není skladem" contains "skladem".
  if (/\b(neni|nie je)\b.*\bsklad/.test(t) || /nedostupn|vyprodan|vypredan/.test(t)) return "out of stock";
  if (/vyrazen|vyradeny|ukonc|discontinu|nevyraba/.test(t)) return "discontinued";
  if (/predobjednav|predobjednat|predprodej|predpredaj/.test(t)) return "preorder";
  if (/\bsklad(em|om)\b/.test(t)) return /[<≤]\s*\d|posledni|posledne|last\b/.test(t) ? "limited stock" : "in stock";
  return undefined;
}

/**
 * `availability` label plus, when it adds information, the raw upstream text.
 * Unrecognised text is kept as the label so nothing is lost.
 */
export function availabilityFields(raw: string | undefined | null): { availability?: string; availabilityText?: string } {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const trimmed = raw.trim();
  const label = normalizeAvailability(trimmed);
  if (!label) return { availability: trimmed };
  return label === trimmed ? { availability: label } : { availability: label, availabilityText: trimmed };
}
