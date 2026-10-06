# `compare_products` live verification — 2026-10-06

Issues: [#11](https://github.com/lukabudik/alza-mcp/issues/11) (tool) and
[#18](https://github.com/lukabudik/alza-mcp/issues/18) (MCP-sampling summary).

## Setup

- Built server (`npm run build`), driven through an in-memory MCP client
  (`InMemoryTransport`) against production `www.alza.cz`.
- Anonymous: `ALZA_TOKEN_FILE=none`. Managed headless Chromium, Chrome-fingerprint
  sidecar available (`ALZA_CF_PYTHON`).
- The test client advertised `capabilities.sampling` and answered
  `sampling/createMessage` with a fixed stub string, so the run proves the server
  side of the round trip (capability check, request shape, result merge), not the
  quality of any real LLM verdict.
- Three runs in total, sequential (two before and one after the entity fix
  below). Each run: one `search_products` call and one `compare_products` call
  with three codes, then a second `compare_products` call with two codes that
  hits the cache.

## Calls

1. `search_products({query: "monitor 27", limit: 3})` → first two codes
   `WC120a93l7` (27" Philips 27E1N1600AE) and `WC118a12b15` (27" AOC Q27G4ZR).
2. `compare_products({codes: ["WC120a93l7", "WC118a12b15", "NOTAREALCODE1"], summarize: true})`.
3. `compare_products({codes: ["WC120a93l7", "WC118a12b15"]})`, the same codes
   again to check the product cache.

## Results

| Check | Result |
|---|---|
| Whole call | `isError` unset; 3 columns returned |
| Per-product error | `NOTAREALCODE1` → `{ok: false, error: "product NOTAREALCODE1 not found"}`; the two real products still compared |
| Rows | 37 = Price, Availability, Rating + 34 spec rows (union of both products' specs, exact-name aligned; product-specific rows such as `DisplayPort`, `Barevné pokrytí (sRGB)` show `—` for the other) |
| Fixed rows | Price `5557 CZK` / `5700 CZK`; Availability `InStock` / `InStock`; Rating `4.6/5` / `4.3/5` |
| Latency | ~16–17 s for 3 codes on a cold browser (concurrency 2); 0–1 ms for the cached re-call |
| Sampling request | `maxTokens: 400`, `includeContext: "none"`, system prompt restricts the model to the table |
| Summary | `{status: "generated", model: "stub-echo", text: …}` merged into `structuredContent.summary` and appended to the Markdown |

Excerpt of `content[0].text` (after the entity fix):

```
| Spec | 27 Philips 27E1N1600AE (WC120a93l7) | 27 AOC Q27G4ZR (WC118a12b15) | NOTAREALCODE1 (error) |
|---|---|---|---|
| Price | 5557 CZK | 5700 CZK | — |
| Availability | InStock | InStock | — |
| Rating | 4.6/5 | 4.3/5 | — |
| Úhlopříčka | 27 " (68,58 cm) | 27 " (68,58 cm) | — |
| Obnovovací frekvence | 120 Hz | 240 Hz | — |
| Odezva | 4 ms | 1 ms | — |
| Nativní kontrast | 1500:1 | 1000:1 | — |
| …
Errors:
- NOTAREALCODE1: product NOTAREALCODE1 not found
```

## Bug found and fixed in the same change

The first two runs showed `Úhlopříčka` as `27 &quot; (68,58 cm)`. JSON-LD
`additionalProperty` strings come HTML-escaped, and `pickAdditionalProperties`
passed them through unchanged. That function now decodes XML and numeric
entities. The third run shows `27 " (68,58 cm)`. The fix also applies to
`get_product`.

## Labels

- `compare_products` table path (product pages via `Catalog.getProduct`):
  **live-verified** 2026-10-06.
- `summarize: true` server-side sampling round trip: **live-verified** with a
  stub sampling client against live product data. A real sampling-capable host
  (where an actual LLM writes the verdict) was **not** exercised. The
  behaviour without the capability is covered by unit tests
  (`test/compare-products.test.ts`).
