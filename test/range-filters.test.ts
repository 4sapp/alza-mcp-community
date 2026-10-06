import { describe, expect, it } from "vitest";
import {
  buildFilteredCategoryUrl,
  buildRangeHash,
  droppedFilterSegments,
  findScreenDiagonalGroup,
  formatRangeNumber,
  parseAppliedRanges,
  snapRange,
  snapScreenInches,
} from "../src/domain/catalog.js";
import { Catalog } from "../src/domain/catalog.js";
import type { FacetGroup } from "../src/domain/types.js";
import type { AlzaBrowser } from "../src/infra/browser.js";
import { formatCategoryFilters, formatSearchResult } from "../src/tools/format.js";
import { splitFilterArgs } from "../src/tools/search-products.js";

// Shapes taken from the live facets API for /lcd-monitory/18842948.htm and
// /televize/18849604.htm (2026-10-06): monitor diagonal steps are millimetres,
// TV diagonal steps are inches.
const monitorDiagonal: FacetGroup = {
  paramId: 17816,
  name: "Úhlopříčka",
  renderType: "Slider",
  filterable: true,
  filterMode: "range",
  values: [
    { valueId: 684, value: 684, description: '26,93 " (68,4 cm)' },
    { valueId: 685, value: 685.8, description: '27 " (68,58 cm)' },
    { valueId: 711, value: 711.2, description: '28 " (71,12 cm)' },
    { valueId: 800, value: 800, description: '31,5 " (80 cm)' },
    { valueId: 812, value: 812.8, description: '32 " (81,28 cm)' },
    { valueId: 2667, value: 2667, description: '105 " (266,7 cm)' },
  ],
};

const tvDiagonal: FacetGroup = {
  paramId: 41706,
  name: "Úhlopříčka",
  renderType: "Slider",
  filterable: true,
  filterMode: "range",
  values: [
    { valueId: 10, value: 10.1, description: '10,1 " (25,65 cm)' },
    { valueId: 55, value: 55, description: '55 " (139,7 cm)' },
    { valueId: 65, value: 65, description: '65 " (165,1 cm)' },
  ],
};

const refreshRate: FacetGroup = {
  paramId: 17819,
  name: "Obnovovací frekvence",
  renderType: "Slider",
  filterable: true,
  filterMode: "range",
  values: [
    { valueId: 60, value: 60, description: "60 Hz" },
    { valueId: 144, value: 144, description: "144 Hz" },
    { valueId: 165, value: 165, description: "165 Hz" },
    { valueId: 240, value: 240, description: "240 Hz" },
  ],
};

const brand: FacetGroup = {
  paramId: 18740,
  name: "Grafické rozhraní",
  renderType: "Checkbox",
  filterable: true,
  filterMode: "value",
  values: [{ valueId: 239739715, description: "HDMI" }],
};

describe("buildRangeHash", () => {
  it("matches the hash Alza's page writes after a real slider drag", () => {
    expect(buildRangeHash([{ paramId: 17816, from: 711.2, to: 2667 }])).toBe(
      "#f&cud=0&pg=1&prod=&par17816=711.2--2667"
    );
  });

  it("encodes the page and multiple sliders", () => {
    expect(
      buildRangeHash(
        [
          { paramId: 17816, from: 812.8, to: 2667 },
          { paramId: 17819, from: 144, to: 240 },
        ],
        3
      )
    ).toBe("#f&cud=0&pg=3&prod=&par17816=812.8--2667&par17819=144--240");
  });

  it("never emits exponent notation", () => {
    expect(formatRangeNumber(0.00001)).toBe("0.00001");
    expect(formatRangeNumber(1e-7)).toBe("0.0000001");
    expect(formatRangeNumber(700000000)).toBe("700000000");
  });
});

describe("range URL composition", () => {
  it("appends the hash to the checkbox/brand path, and the redirect guard ignores the hash", () => {
    const url =
      buildFilteredCategoryUrl("https://www.alza.cz", 18842948, [1432], [{ paramId: 18740, valueId: 239739715 }]) +
      buildRangeHash([{ paramId: 17816, from: 812.8, to: 2667 }]);
    expect(url).toBe("https://www.alza.cz/18842948-v1432-par18740-239739715.htm#f&cud=0&pg=1&prod=&par17816=812.8--2667");
    expect(droppedFilterSegments(url, [1432], [{ paramId: 18740, valueId: 239739715 }])).toEqual([]);
    // a redirect that drops the checkbox segment but keeps the hash is still caught
    expect(
      droppedFilterSegments("https://www.alza.cz/lcd-monitory/18842948-v1432.htm#f&par17816=812.8--2667", [1432], [
        { paramId: 18740, valueId: 239739715 },
      ])
    ).toEqual(["param 18740=239739715"]);
  });
});

describe("snapRange", () => {
  it("snaps min up and max down to real slider steps", () => {
    expect(snapRange(refreshRate, 100, 200)).toEqual({ paramId: 17819, name: "Obnovovací frekvence", from: 144, to: 165 });
  });

  it("fills an omitted bound with the slider's end (Alza needs both bounds)", () => {
    expect(snapRange(refreshRate, 144)).toMatchObject({ from: 144, to: 240 });
    expect(snapRange(refreshRate, undefined, 144)).toMatchObject({ from: 60, to: 144 });
  });

  it("keeps exact step values (including fractional ones) inclusive", () => {
    expect(snapRange(monitorDiagonal, 711.2, 812.8)).toMatchObject({ from: 711.2, to: 812.8 });
  });

  it("is undefined when no step lies in the range", () => {
    expect(snapRange(refreshRate, 61, 143)).toBeUndefined();
    expect(snapRange(refreshRate, 300)).toBeUndefined();
  });
});

describe("findScreenDiagonalGroup / snapScreenInches", () => {
  it("finds the diagonal slider by its inch labels, not by param id or unit", () => {
    expect(findScreenDiagonalGroup([brand, refreshRate, monitorDiagonal])?.paramId).toBe(17816);
    expect(findScreenDiagonalGroup([tvDiagonal, refreshRate])?.paramId).toBe(41706);
    expect(findScreenDiagonalGroup([brand, refreshRate])).toBeUndefined();
  });

  it("maps inches to millimetre steps on monitors", () => {
    // 27" must include 685.8 (27") but not 684 (26.93")
    expect(snapScreenInches(monitorDiagonal, 27, 32)).toMatchObject({ from: 685.8, to: 812.8 });
    expect(snapScreenInches(monitorDiagonal, undefined, 31.5)).toMatchObject({ from: 684, to: 800 });
  });

  it("maps inches to inch steps on TVs", () => {
    expect(snapScreenInches(tvDiagonal, 50)).toMatchObject({ paramId: 41706, from: 55, to: 65 });
  });

  it("is undefined when no size is in range", () => {
    expect(snapScreenInches(tvDiagonal, 70, 80)).toBeUndefined();
  });
});

describe("parseAppliedRanges", () => {
  it("reads slider ranges back from the page's Filter request body, ignoring checkbox params", () => {
    // Trimmed from the live request body captured 2026-10-06.
    const body = {
      idCategory: 18842948,
      parameters: [
        { typeId: 18740, valueFrom: null, valueTo: null, values: [239739715], valueIds: ["18740-239739715"] },
        { typeId: 17816, valueFrom: 812.8, valueTo: 863.6, orderFrom: 12, orderTo: 13 },
        { typeId: 17819, valueFrom: 144, valueTo: 610, orderFrom: 4, orderTo: 20 },
      ],
    };
    expect(parseAppliedRanges(body)).toEqual([
      { paramId: 17816, from: 812.8, to: 863.6 },
      { paramId: 17819, from: 144, to: 610 },
    ]);
  });

  it("tolerates missing or malformed bodies", () => {
    expect(parseAppliedRanges(undefined)).toEqual([]);
    expect(parseAppliedRanges({ parameters: "nope" })).toEqual([]);
  });
});

describe("splitFilterArgs", () => {
  it("routes value_id entries to filters and min/max entries to ranges", () => {
    expect(
      splitFilterArgs([
        { param_id: 18740, value_id: 239739715 },
        { param_id: 17819, min: 144 },
        { param_id: 17816, min: 711.2, max: 812.8 },
      ])
    ).toEqual({
      filters: [{ paramId: 18740, valueId: 239739715 }],
      ranges: [
        { paramId: 17819, min: 144, max: undefined },
        { paramId: 17816, min: 711.2, max: 812.8 },
      ],
    });
  });

  it("rejects a range entry with no bound", () => {
    expect(() => splitFilterArgs([{ param_id: 17819 }])).toThrow(/min and\/or max/);
  });

  it("returns nothing for no filters", () => {
    expect(splitFilterArgs(undefined)).toEqual({});
  });
});

describe("formatting", () => {
  it("lists slider groups as range filters with their step values", () => {
    const text = formatCategoryFilters({ categoryId: 18842948, brands: [], groups: [refreshRate, brand] });
    expect(text).toContain("range filter");
    expect(text).toContain("144 Hz → value: 144");
    expect(text).toContain("HDMI → value_id: 239739715");
  });

  it("reports applied ranges in the search summary", () => {
    const text = formatSearchResult({
      query: "monitor",
      total: 0,
      page: 1,
      pageSize: 20,
      products: [],
      appliedRanges: [{ paramId: 17819, name: "Obnovovací frekvence", empty: true }],
    });
    expect(text).toContain("no step in requested range");
  });
});

describe("Catalog.searchProducts range planning", () => {
  // A browser stub that fails loudly if a page fetch is attempted; facets
  // come from the stubbed getCategoryFilters.
  function makeCatalog(groups: FacetGroup[] | Error, onFetch: () => never = () => { throw new Error("unexpected page fetch"); }) {
    const browser = {
      locale: { baseUrl: "https://www.alza.cz" },
      withPage: () => onFetch(),
    } as unknown as AlzaBrowser;
    const catalog = new Catalog(browser);
    catalog.getCategoryFilters = async (categoryId: number) => {
      if (groups instanceof Error) throw groups;
      return { categoryId, brands: [], groups };
    };
    return catalog;
  }

  it("rejects a min/max range on a Checkbox facet", async () => {
    const catalog = makeCatalog([brand, refreshRate]);
    await expect(
      catalog.searchProducts({ query: "m", categoryId: 18842948, ranges: [{ paramId: 18740, min: 1 }] })
    ).rejects.toThrow(/Checkbox facet — filter it with \{param_id, value_id\}/);
  });

  it("rejects an unknown param id and an inverted range", async () => {
    const catalog = makeCatalog([refreshRate]);
    await expect(
      catalog.searchProducts({ query: "m", categoryId: 18842948, ranges: [{ paramId: 1, min: 1 }] })
    ).rejects.toThrow(/not a facet of category 18842948/);
    await expect(
      catalog.searchProducts({ query: "m", categoryId: 18842948, ranges: [{ paramId: 17819, min: 200, max: 100 }] })
    ).rejects.toThrow(/greater than max/);
  });

  it("requires category_id for range filters", async () => {
    const catalog = makeCatalog([refreshRate]);
    await expect(catalog.searchProducts({ query: "m", ranges: [{ paramId: 17819, min: 144 }] })).rejects.toThrow(
      /require category_id/
    );
  });

  it("answers an out-of-range request as empty without fetching a page", async () => {
    const catalog = makeCatalog([refreshRate]);
    const res = await catalog.searchProducts({ query: "m", categoryId: 18842948, ranges: [{ paramId: 17819, min: 1001 }] });
    expect(res.products).toEqual([]);
    expect(res.appliedRanges).toEqual([{ paramId: 17819, name: "Obnovovací frekvence", empty: true }]);
  });

  it("maps min/max_screen_inches to the category's diagonal slider (empty when no size fits)", async () => {
    const catalog = makeCatalog([tvDiagonal]);
    const res = await catalog.searchProducts({ query: "tv", categoryId: 18849604, minScreenInches: 70, maxScreenInches: 80 });
    expect(res.appliedRanges).toEqual([{ paramId: 41706, name: "Úhlopříčka", empty: true, fromScreenInches: true }]);
  });

  it("falls back to the name-heuristic search path when facets are unavailable for screen size alone", async () => {
    let fetches = 0;
    const catalog = makeCatalog(new Error("facets down"), () => {
      fetches++;
      throw new Error("stop after routing");
    });
    await expect(catalog.searchProducts({ query: "tv", categoryId: 18849604, minScreenInches: 50 })).rejects.toThrow(
      /stop after routing/
    );
    expect(fetches).toBe(1);
    // explicit ranges have no fallback, so the facets error surfaces
    await expect(
      catalog.searchProducts({ query: "tv", categoryId: 18849604, ranges: [{ paramId: 41706, min: 50 }] })
    ).rejects.toThrow(/facets down/);
  });
});
