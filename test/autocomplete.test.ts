import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Autocomplete, normaliseQuery, parseWhisper } from "../src/domain/autocomplete.js";
import { formatAutocomplete } from "../src/tools/autocomplete.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/whisper-iphone.json", import.meta.url), "utf8"));

describe("autocomplete (whisperer/v1/whisper)", () => {
  it("parses phrases, categories, brands, products (ids/codes) and articles from the fixture", () => {
    const r = parseWhisper(fixture, "iphone", 5);
    expect(r.suggestions).toContain("iphone");
    expect(r.categories[0]).toMatchObject({ id: 18851638, name: "Mobilní telefony iPhone" });
    expect(r.categories[0].url).toBe("https://www.alza.cz/iphone/18851638.htm");
    expect(r.brands[0]).toMatchObject({ id: 1627, name: "Apple" });
    expect(r.products[0]).toMatchObject({ id: 13078788, code: "RI055b3", name: "iPhone 17 Pro 256GB stříbrná" });
    expect(r.products[0].url).not.toContain("sqid");
    expect(r.articles.length).toBeGreaterThan(0);
  });

  it("honours the per-section limit and tolerates empty/odd payloads", () => {
    expect(parseWhisper(fixture, "iphone", 1).products).toHaveLength(1);
    const empty = parseWhisper({}, "x", 5);
    expect(empty).toMatchObject({ suggestions: [], categories: [], products: [], brands: [], articles: [] });
    expect(parseWhisper(null, "x", 5).products).toEqual([]);
  });

  it("caches by normalised query (case/whitespace-insensitive)", async () => {
    const whisper = vi.fn().mockResolvedValue(fixture);
    const ac = new Autocomplete({ whisper });
    await ac.suggest("iPhone", 5);
    await ac.suggest("  iphone  ", 3);
    expect(whisper).toHaveBeenCalledTimes(1);
    await ac.suggest("iphone 17", 5);
    expect(whisper).toHaveBeenCalledTimes(2);
    expect(normaliseQuery("Čistič   Kol")).toBe("čistič kol");
  });

  it("formats a Markdown summary with ids", () => {
    const text = formatAutocomplete(parseWhisper(fixture, "iphone", 2));
    expect(text).toContain("category_id 18851638");
    expect(text).toContain("code RI055b3");
  });
});
