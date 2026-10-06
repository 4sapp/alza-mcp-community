# AlzaBox locker discovery without a cart — live evidence (2026-10-06)

Issue: [#8](https://github.com/lukabudik/alza-mcp/issues/8). All requests were
anonymous: no OAuth token (`ALZA_TOKEN_FILE=none`), no cart, no visitor state
beyond the Cloudflare clearance the Chrome-fingerprint sidecar
(`scripts/cf-transport.py`, curl_cffi) negotiates. Requests ran one at a time
with pauses between them. Only public locker data (business addresses and GPS)
appears below; nothing personal was involved.

## Sources evaluated

| Candidate | Result (2026-10-06) | Verdict |
|---|---|---|
| `https://www.alza.cz/alzabox.htm` (named in the issue) | HTTP 404. The landing page lives at `https://www.alza.cz/alzabox` (`/alzaboxy` redirects there). | Wrong URL |
| `https://www.alza.cz/alzabox` DOM / embedded JSON | No locker data in the HTML. The map is a client component (`data-component-name="salesNetworkMap"`, `data-selected-pickup-places="[1]"`) that loads its data from an API after hydration. | Not a source by itself, but it led to the API |
| `https://www.alza.cz/seznam-prodejen-a-alzaboxu` ("list of stores and AlzaBoxes") | Client-rendered (`react-ui-renderer`); no data in the HTML. | Not a source by itself |
| `GET /api/personalPickup/v1/places`, `/points` with no `orderId`/`groupId` | HTTP 400 `{"OrderId":["The OrderId field is required."],"GroupId":["The GroupId field is required."]}` (re-confirms 2026-09-26) | Cart-scoped, rejected |
| Throwaway anonymous cart to get a `groupId` | Not needed, so not tried. | Rejected (it would mutate a cart to answer a read question) |
| Headless Playwright on `/alzabox` | Cloudflare interstitial ("Okamžik…", Turnstile) | Not usable without the sidecar |
| **`GET /api/salesNetwork/v1/places`** | **HTTP 200, no cart or login. Returns AlzaBoxes sorted by distance with name, address and GPS.** | **Chosen** |

How the API was found: the `salesNetworkMap` component lives in a lazy webpack
chunk (`chunk 7326` of the 4.231.0 bundle), which calls
`ajaxService.buildUrl(…, "/api/salesNetwork/v1/salesNetworkForm", {types})`.
That form response is a HATEOAS document whose `placesForm.href`,
`pointsForm.href` and `searchForm.href` point to the routes below.

## Endpoint family (all GET, anonymous)

| Route | Observed |
|---|---|
| `/api/salesNetwork/v1/salesNetworkForm?types=1` | 200. `types[]` has counts per type: Alzabox `type 1` = **4017**, Alza branch `type 2` = 37, AlzaPoint 15, PPL ParcelShop 12, PPL Box 24, Balíkovna 3, DPD 21, Packeta 4, Z-Box 20. Also returns `pointsForm`, `placesForm` and `searchForm` (radius options 10/30/50 km). |
| `/api/salesNetwork/v1/places?types%5B0%5D=1&latitude=&longitude=&ordering=0&limit=&offset=` | 200. `pickupPlaces.paging.size` = 4015 (the whole network, sorted from closest; the upstream does not apply `radius`). Each `value[]` entry has `{id "1141354-2680", deliveryId 2680, parcelShopId, typeText "AlzaBox", type 1, state 0, name, addressText "Street N, PSČ City", gpsPosition {latitude, longitude}, image}`. `detail` is `null` in the list. `limit=5000` → HTTP 400 `"The field Limit must be between 0 and 100."` |
| `/api/salesNetwork/v1/places/{deliveryId}/{parcelShopId}` | 200. Same fields plus `detail.openingHours[]` (7 days, e.g. `"Nonstop"` for parcelShopId 1141354), `services`, `articleUrl`. |
| `/api/salesNetwork/v1/points?types%5B0%5D=1&…&leftLongitude=&rightLongitude=&topLatitude=&bottomLatitude=&zoomLevel=` | 200. A whole-country bbox at `zoomLevel=18` returned all 4015 points (about 7 MB). Points have GPS and ids but no name or address. Not used. |

## Implementation choice

`find_pickup_points` makes one `places` request with `limit=100` (the API
maximum) around the geocoded postal code. The 100 nearest lockers always cover
the tool's own `limit` (at most 50). The parsed list is cached for 12 h per
~100 m grid cell. Radius and limit are applied locally. The tool never pages
through the full network, and there's no per-locker detail request, so locker
opening hours aren't returned.

## End-to-end MCP run (built `dist/server.js`, in-memory MCP client)

`ALZA_TOKEN_FILE=none ALZA_CF_PYTHON=<repo>/.venv-cf/bin/python`, 2026-10-06:

```
find_pickup_points {"postal_code":"500 02","types":["alzabox"],"limit":5}   isError=false 741 ms
  alzabox 0.2 km | AlzaBox Hradec Králové - Jungmannova (Hruška) | Jungmannova 1431/28A | 500 02 Hradec Králové | psid 1131921
  alzabox 0.3 km | AlzaBox Hradec Králové - Dykova | Dykova 1328/24 | 500 02 Hradec Králové | psid 1114351
  alzabox 0.5 km | AlzaBox Hradec Králové - V Lipkách (Albert) | V Lipkách 1609/5 | 500 02 Hradec Králové | psid 1136681
  alzabox 0.7 km | AlzaBox Hradec Králové - Labská kotlina (Hruška) | Labská kotlina 1206/9 | 500 02 Hradec Králové | psid 1009585
  alzabox 1.1 km | AlzaBox Hradec Králové - Pražská třída (Maro) | Pražská třída 686/13 | 500 04 Hradec Králové | psid 1148212
find_pickup_points {"postal_code":"110 00","limit":8,"radius_km":10}   isError=false 116 ms
  alzabox 0.4 km | AlzaBox P1 - Nové Město (Galerie Myšák) | Vodičkova 710 | 110 00 Praha 1 | psid 1009401
  … 7 more lockers, 0.4–1.1 km
find_pickup_points {"postal_code":"500 02","types":["alzabox"],"limit":3}   isError=false 0 ms   (cache hit, no upstream request)
find_pickup_points {"postal_code":"170 00","limit":6,"radius_km":5}   (default types → merged)
  alzabox 0.3 km | AlzaBox P7 (Centrum Stromovka) | Veletržní 200/24 | 170 00 Praha 7 | psid 1009252
  branch  0.4 km | AlzaCentrum Praha-Holešovice | Jankovcova 1522/53 | 170 00 Praha 7
  alzabox 0.5 km | AlzaBox P7 - Holešovice - Dukelských Hrdinů | Dukelských Hrdinů 359/21 | 170 00 Praha 7 | psid 1032083
  … 3 more lockers, 0.6–0.7 km
```

The unit-test fixture `test/fixtures/sales-network-places.json` is the
recorded `places` response for 50.2092, 15.8328 (Hradec Králové) with
`limit=3`.

## Still open

- **Product fit:** the locker list can't say whether a given product fits.
  Large items (observed: 34"+ monitors, 2026-09-26) are excluded from the
  whole AlzaBox network. Only the cart flow (`delivery_options`) knows, and
  the tool description says so.
- **XL lockers:** of the 100 lockers nearest central Prague, 48 have the
  `icon-2-xl.svg` image and 52 have `icon-2.svg`. That might mark XL-capable
  lockers, but nothing confirms it, so it isn't exposed. Status: `unresolved`.
- **Opening hours** are only in the per-place detail, which the tool doesn't
  fetch.
- **Other locales** (alza.sk etc.) use the same route on their own origin. Only
  alza.cz was live-verified.
