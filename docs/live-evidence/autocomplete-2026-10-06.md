# Search suggestions (whisperer) — live evidence, 2026-10-06

Label: `live-verified`. Personal data: none (visitor GUID is a random per-run value, not recorded).

## 1. Browser capture

Playwright Chromium (headless, cs-CZ), `https://www.alza.cz/`, focus the search input, then `page.keyboard.type("čistič kol", {delay: 120})` (not `fill`). Network log after focus and during typing:

```
GET xhr  https://webapi.alza.cz/api/anonymous/search/whisperer/v1/emptySearch?country=CZ&eshopUrl=https://www.alza.cz/&visitor=<guid>      (on focus)
GET xhr  .../whisperer/v1/whisper?country=CZ&eshopUrl=https://www.alza.cz/&visitor=<guid>&searchTerm=čisti
GET xhr  .../whisperer/v1/whisper?country=CZ&eshopUrl=https://www.alza.cz/&visitor=<guid>&searchTerm=čistič kol
```

Debounced: only two `whisper` calls fired for ten keystrokes. No Authorization header, no cookies required.

## 2. Plain-HTTP replay (CF sidecar, `ALZA_TOKEN_FILE=none`)

`MobileApi.whisper()` via `ImpersonateTransport` with a fresh visitor GUID and no token:

- `searchTerm=iphone` → 200; 3 articles, 5 categories (first: "Mobilní telefony iPhone" 18851638), 5 commodities (first id 13078788, code `RI055b3`), 5 phrases, 1 producer (Apple, id 1627).
- `searchTerm=čistič kol` → 200; 1 article, 4 categories (Čističe kol a pneumatik 18893750, Čističe disků 18877888, Čističe na kola 18860528, …), 5 commodities, 0 phrases, 3 producers (Meguiar's 8983, Muc-Off 8980, Sonax 8298).
- `emptySearch` → 200; `mostSearchedPhrases` (lego, pokemon, powerbanka, iphone, iphone 17), empty `lastVisitedCommodities`.
- Second call with `"  Čistič  KOL "` served from the normalised-query cache (~1 ms, no request).

Trimmed fixture used by the unit test: `test/fixtures/whisper-iphone.json`.
