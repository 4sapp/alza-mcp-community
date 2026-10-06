# Slider (range) facet filtering — live evidence, 2026-10-06

Issue: lukabudik/alza-mcp#10. Label: **`live-verified`**. Raw capture:
[`range-filters-2026-10-06.json`](range-filters-2026-10-06.json).

All runs were anonymous (headless Playwright Chromium, `ALZA_TOKEN_FILE=none`),
sequential, and about 20 page loads in total. Visitor ids, ad ids and analytics or
log beacons are left out of the capture.

## 1. Real mouse drag on the category page

Page: `https://www.alza.cz/lcd-monitory/18842948.htm`. The diagonal slider
(`#topped-parameter-17816`, `data-max="75"`) is a jQuery UI range slider whose
handles are `<a class="ui-slider-handle">`. The 2026-09-27 attempt used a
programmatic click and saw no XHR. This time Playwright did
`mouse.move` to the left handle, `mouse.down`, 15 × `mouse.move` across 40 % of
the track, and `mouse.up`. That produced:

- **URL hash**: `#f&cud=0&pg=1&prod=&par17816=711.2--2667&sc=513` (a
  same-document navigation, so the path is unchanged). `711.2` is the 28" step in
  millimetres, and `2667` is the slider maximum (105").
- **Canonical**: unchanged (`/lcd-monitory/18842948.htm`). `rel=next` is still
  `-p2.htm`. The pager anchors were rewritten to the same `#f&…` hash.
- **XHR**: `POST /Services/EShopService.svc/Filter` with body
  `{idCategory, producers, parameters:[{typeId:17816, valueFrom:711.2, valueTo:null, orderFrom:"36", orderTo:"75", valueIds:null}], page, pageTo, sort, searchTerm, minPrice, maxPrice, hash, …}`.
- Slider state after the drag: `data-from="36" data-to="75"`. Index 36 of the
  facets API's `values` for 17816 is `v: 711.2` / `28 " (71,12 cm)`. The order
  indices are positions in the facet value list from the facets API (row C3).

## 2. Loading the hash URL in a fresh page applies the filter

| URL hash (fresh page load) | What the page's own JS sent / returned |
|---|---|
| `18842948.htm#f&cud=0&pg=1&prod=&par17816=711.2--2667` | `Filter` body `valueFrom:711.2, valueTo:2667, orderFrom:36, orderTo:75`. Reply `Count` = 658. Results are all ≥ 28". |
| `18842948.htm#f&par17816=700--800` | Values are snapped by the page to `711.2…800` (`orderFrom:36, orderTo:40`), `Count` 15, results 28"–31.5" |
| `18842948.htm#f&par17816=1092.2--` (upper bound left out) | The page rewrote it to `1092.2--69` (the upper bound collapsed to the slider minimum) and returned `Count` 0. **Both bounds are required.** |
| `18842948-v1432-par18740-239739715.htm#f&…&par17816=812.8--2667&par17819=144--1000` | Brand (path) + HDMI checkbox (path) + two sliders (hash) compose. The page added the path's checkbox to the body (`valueIds:["18740-239739715"]`) and clamped the sliders to this subset's own range (`812.8--863.6`, `144--610`). `Count` 13, all AOC 32"–34". |
| `18842948.htm#f&pg=2&par17816=711.2--2667` | `Filter` body `page:2, pageTo:2`. Reply `Page:2`. Pagination is the hash's `pg`. |

`Filter` reply: `application/json`, `{d:{Boxes (the result cards' HTML, same
`.browsingitem` markup as the page), Count, DisplayCount, Page, PagerBottom,
Parameters, Producers, ParametersInfo, MoreUrl, …}}`.

Two things don't work:

- `search.htm?exps=…&idc=18842948#f&par17816=…` does nothing. The search page
  has no slider widgets and sends no `Filter` request. Range filters need the
  category-browse page.
- Rewriting the page's `Filter` body to set `searchTerm: "lg ultragear"` (via
  Playwright route interception) is ignored. `Count` stayed 530, the same as the
  unfiltered ≥ 32" count. So the category-browse path can't take a keyword.

Facet units vary by category. The slider `v` is in the facet's own base unit, so
the unit can't be assumed. The diagonal is millimetres on monitors (`17816`, `711.2` = 28")
and laptops (`316`, `266.7` = 10.5"), but **inches** on TVs (`41706`, `10.1`). Port
counts, Hz, kg and others use their own numbers. RAM on laptops is MB (`65536` = 64
GB).

## 3. MCP end to end (`node dist/index.js` over stdio)

| Call | Applied (read back from the page's `Filter` body) | Spot check |
|---|---|---|
| `list_category_filters({category_id: 18842948})` | 58/58 groups filterable, slider groups `filterMode: "range"` with raw `value` steps | — |
| `filters:[{param_id:17819, min:240}]` (monitors) | `240–1000` Hz | `get_product` on the first result (AOC U27G4R): "Obnovovací frekvence: 320 Hz" |
| `min_screen_inches:42, max_screen_inches:45` + `category_id` (monitors) | `1066.8–1143` mm (`fromScreenInches`) | All results 43"–45" |
| `min_screen_inches:75, max_screen_inches:77` + `category_id: 18849604` (TVs) | `75–77` (inch-unit slider) | All results 75" or 77" |
| `filters:[{param_id:70, min:65536}]` (laptops `18842920`) | `65536–196608` MB | `get_product` on the first result: "Velikost operační paměti RAM: 64 GB" |
| `producer_ids:[1432]` + HDMI checkbox + diagonal ≥ 812.8 + refresh ≥ 144 | `812.8–863.6`, `144–610` | All AOC 32"/34" |
| same refresh filter, `page: 2` | `240–1000` | none of page 1's first 10 products repeat |
| same refresh filter, `sort: "price-asc", limit: 30` | `240–1000` | multi-page sweep, cheapest first (2 490 Kč) |
| `filters:[{param_id:17819, min:1001}]` | `empty: true` (no step ≥ 1001 Hz) | answered without a page fetch |
| `filters:[{param_id:18740, min:1}]` (a Checkbox facet) | — | clear error: use `{param_id, value_id}` |
| `min/max_screen_inches: 34` without `category_id` | — (name heuristic fallback) | all 34" |

## 4. Re-run after rebasing onto `main` (`c14b47b`)

The same MCP calls were run again after the rebase onto `main`, which adds the 2026-10-03
redirect guard (`droppedFilterSegments`) and `getCategoryFilters`. They gave
identical applied ranges and results. In addition:

- `filters:[{param_id:18073, value_id:239735342}, {param_id:17819, min:240}]`
  ("Quad HD" checkbox, which has no landing page, plus a range) gives the same
  clear redirect error as the checkbox-only path. The hash survives the redirect,
  but the dropped path segment is still detected. So a range never hides a dropped
  checkbox filter.
