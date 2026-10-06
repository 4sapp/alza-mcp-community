export interface Product {
  /** Alza product code, e.g. "WEXOA002B0". This is the canonical identifier. */
  code: string;
  /** Numeric internal id used by REST endpoints. */
  id: number;
  name: string;
  url: string;
  image?: string;
  /** Price as a number in the locale's currency. */
  price?: number;
  /** Original / strike-through price, if discounted. */
  originalPrice?: number;
  currency: string;
  availability?: string;
  /** Rating on 0–5 scale (Alza serves 0–100, we normalize). */
  rating?: number;
  brand?: string;
  category?: string;
  /** Spec params (CPU socket, RAM type, etc.) — opaque key/values. */
  params?: ProductParam[];
}

export interface ProductParam {
  name: string;
  value: string;
}

export interface SearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  products: Product[];
  /**
   * How many candidate cards were scanned before filtering/sorting (one
   * page ≈ 24 for relevance/newest or explicit page; up to 3 pages ≈ 72
   * for a client-side price/rating sort). Useful context for "why only N
   * results" — the scan is bounded, not the whole catalog.
   */
  candidatesScanned?: number;
  /**
   * Slider (range) filters Alza's own category page actually applied, read
   * back from the page's filter request — values are snapped to the facet's
   * real steps. `empty: true` means no step fell inside the requested range,
   * so the result is empty without a page fetch.
   */
  appliedRanges?: AppliedRange[];
}

export interface AppliedRange {
  paramId: number;
  name?: string;
  from?: number;
  to?: number;
  /** Set when the requested range contains no facet step (no product can match). */
  empty?: boolean;
  /** Set when this range came from `min_screen_inches`/`max_screen_inches`. */
  fromScreenInches?: boolean;
}

export interface Category {
  id: number;
  name: string;
  url?: string;
  parentId?: number;
  childCount?: number;
}

export interface ProductReview {
  author?: string;
  date?: string;
  rating?: number;
  body?: string;
}

export interface ProductReviews {
  code: string;
  ratingAverage?: number;
  reviewCount?: number;
  reviews: ProductReview[];
}

export interface FacetValue {
  /** Numeric value id — the `-par{paramId}-{valueId}` (or `-v{producerId}` for brands) URL segment. */
  valueId: number;
  description: string;
  /** Product count carrying this value, when Alza reports it. */
  count?: number;
  /**
   * Slider (range) facets only: the raw, unrounded step value in Alza's own
   * unit for this facet (e.g. millimetres for a monitor diagonal, inches for
   * a TV diagonal, Hz, kg, …). Pass these numbers as `min`/`max` of a range
   * filter in `search_products`'s `filters`.
   */
  value?: number;
}

export interface FacetGroup {
  /** Numeric param id — the `{paramId}` in `-par{paramId}-{valueId}`. */
  paramId: number;
  name: string;
  /** Alza's UI widget for this facet ("Checkbox", "Slider", …). */
  renderType: string;
  /**
   * True for Checkbox-type facets (filter by `value_id`) and Slider-type
   * facets (filter by `min`/`max` range over `values[].value`, live-verified
   * 2026-10-06; see docs/gap-analysis.md). For Checkbox facets this is
   * necessary but not sufficient: Alza only honours URL filters for facets it
   * publishes landing pages for, and silently redirects the rest to the
   * unfiltered category (live-verified 2026-10-03). `search_products` detects
   * that redirect and errors instead of returning unfiltered results.
   */
  filterable: boolean;
  /** How `search_products` filters on this group: `"value"` (`{param_id, value_id}`) or `"range"` (`{param_id, min?, max?}`). Absent when not filterable. */
  filterMode?: "value" | "range";
  values: FacetValue[];
}

export interface CategoryFilters {
  categoryId: number;
  /** Brands in this category — pass `valueId`s to `search_products` as `producer_ids`. */
  brands: FacetValue[];
  groups: FacetGroup[];
}

export interface PickupPoint {
  type: "alzabox" | "branch";
  id: string;
  name: string;
  address: string;
  city: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  /** Distance from query point, in km. */
  distanceKm?: number;
  openingHours?: string;
  /** Free-form note (e.g. "24/7", "self-service"). */
  note?: string;
}
