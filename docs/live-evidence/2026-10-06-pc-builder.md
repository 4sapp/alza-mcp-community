# PC builder live evidence (issue #15), 2026-10-06

These checks ran without an account (`ALZA_TOKEN_FILE=none`), using the managed headless Chromium (`AlzaBrowser`) from one residential IP. Requests were sequential, and every run made fewer than 25 page loads. No personal data is involved: the product codes and prices below are public catalog data.

## 1. Category discovery (`list_categories`), `live-verified`

`list_categories()` gives **Počítače a notebooky 18890188**, and `list_categories(18890188)` gives **Komponenty 18852654**. From there, `list_categories(18852654)` returns:

| role | category | id |
|---|---|---|
| CPU | Procesory | 18842843 |
| motherboard | Základní desky | 18842832 |
| RAM | Paměti → DDR5 / DDR4 | 18893268 / 18855197 |
| GPU | Grafické karty | 18842862 |
| storage | Disky a SSD → SSD | 18845887 |
| case | Skříně a zdroje → Skříně | 18849057 |
| PSU | Skříně a zdroje → Zdroje | 18849164 |
| CPU cooler | Chlazení → Na procesory | 18842846 |

Browsing each listing page (`/{id}.htm`) returned real in-stock products of the right type. Examples:
- CPU: `BD750m7b1` AMD Ryzen 7 9800X3D.
- PSU: `UY006rm85new` Corsair RM850x.
- Cooler: `ENDf5` Endorfy Fera 5.

## 2. Facet filters (`list_category_filters` + `search_products({filters})`)

`list_category_filters` lists the useful checkbox facets with real ids:
- CPU 18842843: `Socket` param 432 (AM5 = 239891229), `Řada procesoru` 433 and `Podporovaný typ paměti` 14463.
- Motherboard 18842832: `Socket` 408, `Formát základní desky` 411 (ATX = 1454) and `Typ paměti` 414 (DDR5 = 1134).

Alza does **not** honour these as URL filters. It 30x-redirects to the unfiltered category, and `search_products` returns its "does not support URL filtering" error. Each of the following was rejected on 2026-10-06, so these filters are **`blocked`**:
- CPU `-par432-239891229` (socket AM5)
- CPU `-par433-182001` (Ryzen 5)
- Motherboard `-par408-239891229` (socket AM5)
- Motherboard `-par411-1454` (ATX)
- Motherboard `-par414-1134` (DDR5)

The PC builder therefore narrows candidates on the client, in two steps:
1. Name hints on the listing cards (chipset → socket, DDR type, PSU wattage).
2. The detail page's `params`.

The memory-type facet is replaced by the dedicated DDR5 and DDR4 RAM categories. The brand facet (`producer_ids`) is the facet that works in every category, and `pc_build_suggest` uses it for `cpu_vendor`.

## 3. `search.htm?idc=` does not restrict to the category, `live-verified` (negative)

`searchProducts({query: "psu", categoryId: 18849164})` returned dog food (`KRMP1156` …). The query text matched across the whole catalog, so `idc` did not scope the search to the category. `cooler` in category 18842846 returned Cooler Master PSUs. Candidate sourcing therefore browses the category listing page through the new internal `SearchOptions.browse`. That reuses the existing category-URL path in `Catalog.buildSearchUrl`.

## 4. Spec names per component type, `live-verified`

These rows come from `get_product` on real pages. They seed `SPEC_NAME_MAP` in `src/domain/pc-build.ts` and the fixtures in `test/pc-build.test.ts`.

| type | product | rows used |
|---|---|---|
| CPU | `BD750j16a10` Ryzen 7 5800X3D | `Socket` "AMD AM4", `Podporovaný typ paměti` "DDR4", `TDP` "105 W", `Typ integrované grafické karty` "Bez integrovaného grafického čipu" |
| motherboard | `ACb760pmawd4` ASUS PRIME B760M-A WIFI D4 | `Socket` "Intel 1700", `Formát základní desky` "mATX (Micro ATX)", `Typ paměti` "DDR4", `Počet slotů RAM` "4 ×", `Provedení` "DIMM" |
| RAM | `DP095b32c60` Patriot Viper Venom 32GB KIT DDR5 | `Typ paměti` "DDR5", `Provedení` "DIMM", `Počet modulů v balení` "2 ks", `Moduly v balení` "2 × 16GB" |
| GPU | `EGr56t16p1` Gainward RTX 5060 Ti 16G | `Šířka` "291,9 mm" (length), `Výška` "41,3 mm", `Hloubka` "116,5 mm", `TDP` "180 W" |
| GPU | `XFXr97xm4` XFX RX 9070 XT | `Šířka` "360 mm", no `TDP` row, `Doporučený výkon zdroje` "800 W" |
| case | `MONk95w` Montech KING 95, `CBh5f5` NZXT H5 Flow | `Formát základní desky` "ATX,mATX (Micro ATX),mITX (Mini ITX)[,eATX (Extended ATX)]", `Max. výška chladiče procesoru` "175 / 170 mm", `Max. délka grafické karty` "420 / 410 mm", `Podporovaný formát zdroje` "ATX", `Podporovaná velikost radiátoru navrchu/zepředu/zboku` |
| PSU | `CCegfm5` CM Elite Gold 750, `UY006rm85new` RM850x | `Výkon` "750 W" / "850 W", `Formát` "ATX" |
| air cooler | `ENDf5` Fera 5, `BKpr3p2` Pure Rock Pro 3 | `Chlazení` "Vzduchem", `Výška` "155 mm", `AMD Socket` "AM4,AM5", `Intel Socket` "1150,…,1700,1851" |
| liquid cooler | `CTke360rv2b` NZXT Kraken Elite 360 | `Chlazení` "Vodou", `Kompatibilní velikost radiátoru` "360mm", `AMD Socket` / `Intel Socket` |
| SSD | `FWsn7100a4` WD_BLACK SN7100 2 TB | `Typ úložiště` "SSD", `Rozhraní interní` "M.2 (PCIe 4.0 4x NVMe)" |

**The 30-row cap was too tight.** The RTX 5060 Ti page has 30 spec rows, and `TDP` is row 29. `get_product`'s cap of 30 left almost no margin. `Catalog.getProductSpecs` now keeps up to 80 rows for the builder. It uses the same page load and cache. `get_product` still returns at most 30 rows.

## 5. End-to-end tool run, `live-verified`

This ran over the in-memory MCP client against the real server (`buildServer()`) with `set_toolset({id: "pc_builder", enabled: true})`.

### `pc_build_suggest({budget: 35000, profile: "gaming", cpu_vendor: "amd"})`

The call took 31 s: 7 product page loads and 9 category page loads (8 listings plus the CPU brand facet). Overall result: **needs_review**. Total **34 856 CZK of 35 000**, and every part was in stock.

| role | code | product | price |
|---|---|---|---|
| cpu | `BD750l7g1` | AMD Ryzen 7 8700G | 6 090 |
| motherboard | `ACb850t1` | ASUS TUF GAMING B850-PLUS WIFI | 4 790 |
| ram | `DP096a16a60` | Patriot Viper Elite 5 16GB DDR5 6000 | 6 190 |
| gpu | `ECr76d1` | ASUS DUAL Radeon RX 7600 8G OC EVO | 8 190 |
| storage | `SAS990a3` | Samsung 990 1TB | 4 299 |
| case | `CBh5f5` | NZXT H5 Flow (2024) | 1 899 |
| cooler | `ENDfor5d` | Endorfy Fortis 5 Dual Fan | 899 |
| psu | `UEcgx5` | Seasonic Core GX-850 ATX 3.1 | 2 499 |

Verdicts and the spec values they used:
- `cpu_socket_motherboard` **pass**: AM5 (`Socket` "AMD AM5") = AM5.
- `ram_motherboard` **pass**: DDR5 fits DDR5, 1/4 slots used.
- `ram_cpu` **pass**: DDR5.
- `psu_wattage` **warn**: 850 W ≥ 550 W recommended, but the GPU page lists no TDP. Its draw was estimated at 220 W from `Doporučený výkon zdroje` "550 W", and at that point a derived figure still produced a warn.
- `gpu_length_case` **pass**: 229 mm (`Šířka`) ≤ 410 mm.
- `cooler_clearance_case` **pass**: 159 mm ≤ 170 mm.
- `cooler_socket` **pass**: AM5 is in the cooler's list.
- `motherboard_form_factor_case` **pass**: ATX is in "ATX, mATX, mITX, eATX".
- `psu_form_factor_case` **pass**: ATX.
- `display_output` **pass**.

Two changes followed from this run:
1. A PSU estimate derived from a listed spec now passes, with the assumption stated in `detail`. Only a blind fallback, where there is no power spec at all, still warns.
2. For RAM, multi-module kits are now ranked first, and a single-module build gets an advisory note.

### `pc_build_check` with the same 8 codes

The check took 1.6 s, because all 8 products were served from the catalog cache (8 product page loads requested). It returned the same verdicts as the suggest run.

### `pc_build_check` with the motherboard swapped to `ACb550tgp` (ASUS TUF GAMING B550-PLUS)

Overall result: **incompatible**.
- `cpu_socket_motherboard` **fail**: "CPU socket AM5 does not fit the motherboard socket AM4."
- `ram_motherboard` **fail**: "DP096a16a60 is DDR5 but the board takes DDR4."
- Every other rule kept its earlier verdict.

## 6. Second build (final code), `live-verified`

### Iteration 2, which surfaced a render race

`pc_build_suggest({budget: 30000, cpu_vendor: "intel"})` showed two problems:
- The PSU `AAnagp2a4` (MSI MAG A750GL PCIE5 II) came back with **no spec rows**. `psu_wattage` and `psu_form_factor_case` were `unknown`, and the follow-up `pc_build_check` could not detect the part's role.
- A cooler that cleared the case by only 2 mm (`ENDfor5d`, 159 mm in a 161 mm case) was accepted with a warn.

A fresh read of the same product a minute later returned the full table (`Výkon` "750 W", `Formát` "ATX", …). The table had simply not rendered by the `load` event. Fixes:
1. `Catalog.getProductSpecs`/`getProduct` now wait up to 4 s for the spec table and read the page again whenever neither spec source has rows. Only pages without specs pay for this.
2. Suggest keeps looking for a clean pass when a candidate only warns, as long as the remaining detail budget still covers the later roles.
3. `pc_build_check` tells the agent to pass each part's `role` when it re-checks a suggestion.

### Iteration 3 (final code)

`pc_build_suggest({budget: 30000, profile: "gaming", cpu_vendor: "intel"})` took 41.5 s: 8 product page loads and 9 category page loads. Overall result: **compatible**, every rule `pass`. Total **29 995 CZK of 30 000**, and every part was in stock.

| role | code | product | price | spec rows used |
|---|---|---|---|---|
| cpu | `BOu5250kp` | Intel Core Ultra 5 250K Plus | 5 999 | `Socket` "Intel 1851", `Podporovaný typ paměti` "DDR5", `TDP` "159 W", `Typ integrované grafické karty` "Intel Graphics" |
| motherboard | `ACb860t2` | ASUS TUF GAMING B860M-PLUS WIFI | 4 390 | `Socket` "Intel 1851", `Typ paměti` "DDR5", `Počet slotů RAM` "4 ×", `Formát základní desky` "mATX (Micro ATX)" |
| ram | `DP096a16a60` | Patriot Viper Elite 5 16GB DDR5 | 6 190 | `Typ paměti` "DDR5", `Provedení` "DIMM", `Počet modulů v balení` "1 ks" |
| gpu | `ECr76d1` | ASUS DUAL Radeon RX 7600 8G OC EVO | 8 190 | `Šířka` "229 mm", `Doporučený výkon zdroje` "550 W" |
| storage | `DU102n3c` | ADATA Ultimate SU650 256GB | 899 | (listing card only: no rule uses storage) |
| case | `MONa100a2` | Montech AIR 100 LITE White | 1 129 | `Formát základní desky` "mATX (Micro ATX),mITX (Mini ITX)", `Max. délka grafické karty` "330 mm", `Max. výška chladiče procesoru` "161 mm", `Podporovaný formát zdroje` "ATX" |
| cooler | `ENDf5a` | Endorfy Fera 5 ARGB | 799 | `Chlazení` "Vzduchem", `Výška` "155 mm", `Intel Socket` incl. 1851 |
| psu | `AAnagp2a4` | MSI MAG A750GL PCIE5 II | 2 399 | `Výkon` "750 W", `Formát` "ATX" |

- The cooler `ENDfor5d` (159 mm in a 161 mm case → warn) was passed over for `ENDf5a` (155 mm → pass).
- Power: 510 W estimated peak. The CPU's 159 W TDP × 1.35 gives 215 W. The GPU gives 220 W, derived from its 550 W PSU recommendation. The platform adds 75 W. The recommended PSU is ≥ 670 W, and the 750 W unit passes.
- Advisory note: the RAM is a single module, so it runs single-channel. At this budget, Alza's first DDR5 listing page had no 2-module kit within the allocation.

`pc_build_check` with the same 8 codes and roles took 4.3 s. It returned **compatible** and the same verdicts.

The same check with the board swapped to `ACb550tgp` returned **incompatible**:
- `cpu_socket_motherboard` fail: LGA1851 vs AM4.
- `ram_motherboard` fail: DDR5 vs DDR4.
- `motherboard_form_factor_case` fail: an ATX board does not fit the mATX/mITX case.
