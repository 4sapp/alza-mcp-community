import { TtlCache } from "../infra/cache.js";
import type { MobileApi } from "../infra/mobile-api.js";

export interface SuggestedCategory {
  id: number;
  name: string;
  url: string;
}
export interface SuggestedProduct {
  id: number;
  /** Alza product code (from the image path), when present. */
  code?: string;
  name: string;
  url: string;
  image?: string;
}
export interface SuggestedBrand {
  id: number;
  name: string;
  url: string;
}
export interface SuggestedArticle {
  name: string;
  url: string;
}
export interface AutocompleteResult {
  query: string;
  suggestions: string[];
  categories: SuggestedCategory[];
  products: SuggestedProduct[];
  brands: SuggestedBrand[];
  articles: SuggestedArticle[];
}

interface ClickAction {
  webLink?: string;
  href?: string;
  name?: string;
}
interface WhisperItem {
  clickAction?: ClickAction;
  imageUrl?: string;
  urlImage?: string;
}
interface WhisperResponse {
  articles?: WhisperItem[];
  categories?: WhisperItem[];
  commodities?: WhisperItem[];
  phrases?: WhisperItem[];
  producers?: WhisperItem[];
}

/** Drop the analytics tracking query (`evt`, `pos`, `ste`, `sqid`) Alza appends to suggestion links. */
function cleanUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    for (const k of ["evt", "pos", "ste", "sqid"]) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

export function normaliseQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Parse the `whisperer/v1/whisper` payload. Pure — unit-tested against a fixture. */
export function parseWhisper(raw: unknown, query: string, limit: number): AutocompleteResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as WhisperResponse;
  const list = (items: WhisperItem[] | undefined): WhisperItem[] => (Array.isArray(items) ? items.slice(0, limit) : []);

  const suggestions: string[] = [];
  for (const it of list(r.phrases)) {
    const name = it.clickAction?.name;
    if (name && !suggestions.includes(name)) suggestions.push(name);
  }

  const categories: SuggestedCategory[] = [];
  for (const it of list(r.categories)) {
    const a = it.clickAction;
    const id = Number(a?.href?.match(/\/category\/(\d+)/)?.[1] ?? a?.webLink?.match(/\/(\d+)\.htm/)?.[1]);
    if (a?.name && Number.isFinite(id)) categories.push({ id, name: a.name, url: cleanUrl(a.webLink) });
  }

  const products: SuggestedProduct[] = [];
  for (const it of list(r.commodities)) {
    const a = it.clickAction;
    const id = Number(a?.href?.match(/\/product\/(\d+)/)?.[1] ?? a?.webLink?.match(/-d(\d+)\.htm/)?.[1]);
    if (!a?.name || !Number.isFinite(id)) continue;
    const code = it.imageUrl?.match(/\/products\/([^/]+)\//)?.[1];
    products.push({ id, ...(code ? { code } : {}), name: a.name, url: cleanUrl(a.webLink), ...(it.imageUrl ? { image: it.imageUrl } : {}) });
  }

  const brands: SuggestedBrand[] = [];
  for (const it of list(r.producers)) {
    const a = it.clickAction;
    const id = Number(a?.href?.match(/[?&]P=(\d+)/)?.[1] ?? a?.webLink?.match(/\/v(\d+)\.htm/)?.[1]);
    if (a?.name && Number.isFinite(id)) brands.push({ id, name: a.name, url: cleanUrl(a.webLink) });
  }

  const articles: SuggestedArticle[] = [];
  for (const it of list(r.articles)) {
    const a = it.clickAction;
    if (a?.name) articles.push({ name: a.name, url: cleanUrl(a.webLink ?? a.href) });
  }

  return { query, suggestions, categories, products, brands, articles };
}

export class Autocomplete {
  private readonly cache = new TtlCache<string, WhisperResponse>(5 * 60_000, 200);

  constructor(private readonly api: Pick<MobileApi, "whisper">) {}

  /** Plain-HTTP suggestions (CF sidecar chain), cached by normalised query. */
  async suggest(query: string, limit = 5): Promise<AutocompleteResult> {
    const key = normaliseQuery(query);
    const raw = await this.cache.memoize(key, async () => (await this.api.whisper(query.trim())) as WhisperResponse);
    return parseWhisper(raw, query.trim(), limit);
  }
}
