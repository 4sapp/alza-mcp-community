# Alza API gap analysis (2026-09-08)

Prioritized list of every unmapped gap / missing feature found across the
**mobile surface** and the **web checkout APIs** (new-goal scope), from:
the latest-APK re-audit (task 1), the `m.alza.cz` React checkout capture
(task 2), the WCF/REST family completion (task 3), and the mobile-pipeline
gap re-verification (task 4). Sources of truth:
`docs/mobile-endpoint-coverage.md` (rows + labels) and `docs/live-evidence/`
(dated records). Priority = user value × feasibility inside the MCP security
boundary (no new transports, typed + validated + one-time-token flows only).

## P0 — close end-to-end (top-priority implementation set)

### G1. Typed exposure of the verified web order + payment pipeline (closes O5/O11)

- **The gap:** the only *working* order-submission path on Alza today is the
  legacy web WCF chain (`SaveOrder2 → SaveOrder3 → SaveAndConfirmOrder2
  (113-gate retry) → CheckOrder4 → SendOrder4`), live-verified twice
  (2026-09-06 real order + 2026-09-08 re-checks). It is *documented* (O11,
  W16, PA8–PA10) but **not exposed as a typed tool** — the mobile typed
  `alza_place_order` is blocked at `sendOrder3` (HTTP 500, G3). Same for the
  after-order payment: the web `CreateAfterPayment` (PA9) executed a real
  payment (MojePlatba → KB SSO) but is documented-only.
- **Why P0:** this is the difference between "MCP can talk about orders" and
  "MCP can place and pay for a real order end-to-end through typed,
  validated, token-guarded tools."
- **Implementation (task 6):**
  - `alza_web_place_order` (high-impact, one-time token from
    `alza_prepare_mutation`): explicit inputs — delivery group/delivery/
    parcel-shop, payment method, user-info block (validated subset of the
    O11 `SaveOrder3` DTO: name, street, city, zip, phone, email,
    countryId), consents. Server-side flow: `SaveOrder2` (with
    `alzaPlusSubscriptionId:0`/`cetelemLeasingId:0` gate-skip) →
    `SaveOrder3` → `SaveAndConfirmOrder2` (auto-retry once on
    `ErrorLevel:113`, the documented AlzaPlus promo gate) → `CheckOrder4` →
    `SendOrder4`; returns the created order id + `GetOrderDetailAction`
    hash link.
  - `alza_web_pay_after_order` (high-impact, one-time token):
    `GetAfterPaymentDialog` (method list, read) + `CreateAfterPayment`
    execution with a validated `paymentId` from the dialog; returns the
    gateway hand-off (e.g. KB SSO URL) — the recorded MojePlatba flow.
  - Whitelist additions to `alza_prepare_mutation`:
    `web_place_order`, `web_after_order_payment` (high-impact set).
  - Unit tests for input validation + the 113-retry logic (mocked
    transport); live verification (task 7) on the real account with a
    minimal-cost order + real after-payment, final states recorded.

### G2. Flip the typed delivery/payment tools from v12 to v13 (closes D1)

- **The gap:** app 2026.17 (latest release) calls
  `getDeliveryPaymentGroups` **v13**; v12 is served in parallel. The typed
  tools (`alza_delivery_options`, `alza_payment_methods`) and the
  `delivery_payment_groups` read path still call **v12**. Both versions are
  live (re-verified 2026-09-07 *and* 2026-09-08).
- **Why P1:** small, safe, keeps the typed surface current with the app;
  the v13 response models add the 2026.17 server-driven action fields
  (`afterSelectAction`/`afterDeselectAction`, `Payment.isConditionalFreeDelivery`,
  `CardPayment.hideStoredPaymentCards`) that the response pass-through should
  carry.
- **Implementation (task 6):** route flip in the typed tools + whitelist
  entry (v13 kept as a fallback if v13 404s), unit tests, live re-check.

### G3. Web pickup-point family tool (closes W11–W14)

- **The gap:** the new HATEOAS web pickup family
  (`/api/personalPickup/v1/pickupPlaceForm|points|places|places/{id}`,
  live-mapped task 2) is the pickup surface of the *current* web checkout.
  The mobile `find_pickup_points` / `alza_select_pickup_point` cover the
  mobile equivalents only; the web family is documented but not exposed.
- **Why P1:** read-only, no token needed, directly usable for web-checkout
  delivery selection (pairs with G1: the `parcelShopId`/`deliveryId` that
  `alza_web_place_order` needs come from this tool's responses).
- **Implementation (task 6):** typed `alza_web_pickup_places` (read, no
  token) — inputs: optional type filter, latitude/longitude, paging;
  returns the form (type availability) + list + place detail (deliveryId,
  parcelShopId, isFree, typeText, openingHours). Origin-validated
  (www/m.alza.cz), explicit input validation, unit tests, live re-check.

## P1 — close next (documented, deferred in this goal)

### G4. HATEOAS web cart family (W3/W4/W5) — **implemented 2026-09-09**

`checkout/cart`, `checkout/cart/items`, `POST basket/v1/items` (HATEOAS
`appAction` responses). Implemented as two typed tools: **`alza_web_add_to_cart`**
(commodity_id + count → POST `basket/v1/items`; extracts the basket id from the
response's `order/{basketId}/item/{itemId}` link; the basket is visitor-keyed and
the cookie-less add with a Balancer-Guid header was live-verified 2026-09-09) and
**`alza_web_cart`** (basket_id → the W3 cart state + W4 item list). Unit-tested
(exact body, exact routes, validation); live evidence
`docs/live-evidence/gap-fix-probe-2026-09-09.json` + `gap-fix-probe3-2026-09-09.json`.

### G5. Mobile `sendOrder3` HTTP 500 (O3) — server-side

Re-confirmed 2026-09-06, 2026-09-08 **and** 2026-09-09 (full + empty `Parameters`,
authenticated + guest): `POST /services/restservice.svc/v5/sendOrder3` →
HTTP 500 `InternalServerError` (2026-09-09: fresh basket → sendOrder2 err:0 →
sendOrder3 500, same shape). Nothing the MCP can fix server-side; the
practical closure is G1 (typed web pipeline). Kept `unresolved`; the typed
mobile `alza_place_order` stays live-reached/blocked with the documented
500. **Re-test cadence:** each live-verification run (cheap: one POST).

### G6. Mobile after-order `err:1` for WCF-created orders (PA2/PA3)

Re-confirmed 2026-09-08 **and** 2026-09-09 against still-open order 1056808137
(`getafterorderpayments` → “Faktura se zadaným ID neexistuje”;
`afterOrderPayment` → “Aktualizujte prosím aplikace"). Expected until a
restservice-pipeline order exists (i.e. until G5's 500 is fixed
server-side). The web `CreateAfterPayment` (G1's `alza_web_pay_after_order`)
is the working execution path in the meantime.

## P2 — candidates (documented, not mapped in depth this goal)

| Candidate | Evidence | Note |
|---|---|---|
| Chatbot family (`chatbotapi.alza.cz` `/v1/navigation`, `/v1/chat`, pageType-coded) | W18 (live 2026-09-08) | Out of the 12 families; session-scoped chat — needs its own design (state, intents) |
| Web telemetry (`logapi.alza.cz /api/log/v2/logs`, `metrics/gs/ccm/collect`, `cdn-cgi/rum`) | W19 (live 2026-09-08) | Out of scope by rule; only relevant as a transport note |
| `next-api/auth/get-session` (Next.js bootstrap) | W1 | Framework plumbing; no user value as a tool |
| 2026.17 server-driven action fields (`afterSelectAction`/`afterDeselectAction` on D1 items, `alzaPlusActionBannerAction`) | re-audit 2026-09-07 | `blocked` dynamic actions — typed wrappers only when an action needs server-driven follow-up |
| Bank-app payment channel (PA11: `PayViaBankAppResolver`, preferred-bank-app preference) | re-audit 2026-09-07 | Client-side UX over the same `paymentId` flow; no new API surface |
| `GetZipCodes` on `EShopService.svc` (WCF twin of D5) | probe 2026-09-08 | Documented; the restservice route is the canonical one |
| Device tokens, admin routes, news, prescriptions | earlier audit | Documented out-of-scope (see coverage doc) |

## Explicitly NOT gaps (closed this goal)

- **W16 Order2→3 trigger** — resolved to `SaveOrder2`/`SaveAndConfirmOrder2`
  (2026-09-08 probe: `LeaveOrder2`/`LeaveOrder3` are 404; the Save ops
  advance the WCF state machine).
- **WCF order+payment family completeness** — closed: 92 candidate
  operations probed, exactly 10 exist (probe record 2026-09-08).
- **APK route drift** — stable across 2026.15/16.1/17.0 except the D1
  version bump (→ G2).
- **OAuth client-secret** — decoded, wired, overridable (previous goal).

## Implementation record (task 6, 2026-09-08)

**G2 — implemented.** `MobileApi.deliveryPaymentGroups` now calls **v13** with an
HTTP-404-only fallback to v12 (`src/infra/mobile-api.ts`). Serves
`alza_delivery_options`, `alza_payment_methods`, and `alza_checkout_preview`
automatically. Unit-tested (v13 direct, v13→v12 fallback, no fallback on 500).

**G3 — implemented.** New typed read tool **`alza_web_pickup_places`** (no token):
inputs `order_id?/group_id?/latitude?/longitude?/types[]?/limit?/offset?/place_id?`;
returns `{form, places, detail?}` from the `personalPickup/v1` family
(`webPickupPlaceForm` / `webPickupPlaces` / `webPickupPlaceDetail` in
`MobileApi`, validation in `MobileAccount.webPickupPlaces`). Unit-tested
(input validation + exact routes).

**G1 — implemented.**
- **`alza_web_place_order`** (high-impact, one-time token `web_place_order`):
typed inputs (delivery/group/parcel-shop, payment, user-info block with
email/zip/phone/consent validation); runs `SaveOrder2` (with
`alzaPlusSubscriptionId:0`/`cetelemLeasingId:0` gate-skip) → `SaveOrder3` →
`SaveAndConfirmOrder2` (auto-retry once on `ErrorLevel:113`, the documented
AlzaPlus promo gate) → `CheckOrder4` → `SendOrder4`; throws on any non-zero
`ErrorLevel`; returns `order_id` + `order_detail_link` (GetOrderDetailAction
webLink) + per-step `error_levels`. WCF `d`-envelope unwrapped in
`MobileApi.webWcfStep`.
- **`alza_web_pay_after_order`** (high-impact, one-time token
  `web_after_order_payment`): typed inputs (order_id, payment_id, order_hash?,
  invoice_id?, price?); runs the recorded `CreateAfterPayment` body (the
  2026-09-06 real-payment shape); returns the gateway hand-off result.
- Read companion: `alza_mobile_read` operation **`web_after_payment_dialog`**
  (WCF `GetAfterPaymentDialog`, PA8) — token-free method list for an unpaid order.
- `alza_prepare_mutation` now accepts `web_place_order` + `web_after_order_payment`
  (high-impact set 9→11).
- Unit-tested: full chain happy path incl. the 113-retry, exact WCF bodies
  (SaveOrder2/3 + SendOrder4), non-zero-step failure, single-use token, after-
  order payment body + validation, dialog read route.

All three: `npm test` 60/60, `npm run typecheck`, `npm run build`,
`git diff --check` green (2026-09-08).

**Live verification (task 7, 2026-09-08 — done):** real minimal-cost order
**1057075103** (book FKP0383232, 35 CZK + AlzaBox 2680/1128203, 104 CZK
ex-VAT) created through the exact `alza_web_place_order` WCF chain on the
registered E2E account (user_id 100000001); the `web_after_payment_dialog`
read returned the live after-order method list (213/216/219/143/144/203),
and `alza_web_pay_after_order` (`CreateAfterPayment` 144 MojePlatba) returned
`ErrorLevel:0` with the gateway hand-off
`https://www.alza.cz/Secure/MojePlatba-aop.htm?aop=1325060564`. Final order
state recorded (“Objednávku jsme přijali”, phase 3). Two live findings
folded back into the implementation: the `SendOrder4` top-level `OrderId`
field is 0 (order id now derived from `GetOrderDetailAction`, unit-tested),
and the 113-gate step can also answer with a transient HTTP 404 that leaves
the WCF state valid (the retry covers the documented 113 case). Record:
`docs/live-evidence/web-tool-e2e-2026-09-08.md` (+ 2 JSON captures).

## Implementation record (round 2, 2026-09-09 — remaining-gaps sweep)

After the 2026-09-08 goal closed, a fresh triage of `docs/mobile-endpoint-coverage.md`
+ this report found four actionable items; all are now closed:

- **G4 (above)** — `alza_web_add_to_cart` + `alza_web_cart` typed tools; the
  basket add is visitor-keyed (cookie-less Balancer-Guid add live-verified), so
  the tools work with the standard MCP transport. `webCart` needs only the
  basket_id (the `visitors/{visitorId}` path segment is not validated
  server-side — a placeholder UUID returned the same cart).
- **C12 resolved** (the last `unresolved` catalog row): the C11 navigation
  response carries the full carousel route
  `GET /api/catalog/v1/homePage/categories/{id}?pgri=…&ui=…` (bare route → HTTP
  400; with the server-provided params → 200 `{self, breadcrumbs, name, value,
  disclaimers, shareWebLink}`). Exposed as the `home_categories` read op on
  `alza_mobile_read` (39 read ops now).
- **G5/G6 re-tested 2026-09-09** (above) — both unchanged; they stay
  server-side `unresolved` with a per-run re-test cadence.
- **Found & fixed during the round:** the `web_after_payment_dialog` read op
  (added 2026-09-08) was missing from the `alza_mobile_read` zod enum — the op
  existed in the domain layer but was unreachable through the tool. Now in the
  enum (39 ops).

Not actionable (unchanged): AT3 (vision API — no static route), the P2 table
(boundary/server-side), and the mobile `alza_place_order` path blocked at G5.
Gate: `npm test` 63/63, `npm run typecheck`, `npm run build`, `git diff --check`
green (2026-09-09). Live records: `docs/live-evidence/gap-fix-probe-2026-09-09.json`,
`docs/live-evidence/gap-fix-probe3-2026-09-09.json`.
