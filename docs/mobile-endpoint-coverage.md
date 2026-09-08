# Alza mobile endpoint coverage

Source of truth for which Alza mobile-API operations `alza-mcp` exposes, how each is
exposed, and how it was verified.

- APK: `cz.alza.eshop` 2026.15.0 (decompiled with JADX, `/tmp/alza-decompile/jadx-2026-15/sources`).
  The 2026.17 build was spot-checked for route drift; no in-scope route changes.
- Inventory method: every static route constant in the decompiled sources was extracted
  (string-literal scan of `ndm.b(urlBuilder, ...)` call sites plus concatenated fragments),
  and every server-driven hypermedia action (`AppAction.form.meta`) was mapped from the
  model/action-name registry. Routes below are **source-confirmed** unless labeled otherwise.
- Live evidence: read-only journeys in `scripts/live-user-journeys.py` /
  `scripts/live-endpoint-matrix.py`, plus the end-to-end order+payment record in
  `docs/live-evidence/`.

## Verification labels

| Label | Meaning |
|---|---|
| `source-confirmed` | Route/DTO confirmed in decompiled APK source; not yet exercised live. |
| `live-verified` | Exercised against production through the MCP tool path (or the exact same method+route+DTO) and recorded under `docs/live-evidence/`. |
| `blocked` | Source-confirmed but intentionally not exposed; rationale recorded on the row. |
| `unresolved` | Route/DTO only partially confirmed in source; exposure deferred until verified. |

## Security boundary (unchanged)

- No user-supplied URLs, passwords, access/refresh tokens, or card values are accepted by any
  tool. The client accepts fixed, APK-confirmed operations only.
- Server-driven hypermedia actions (`AppAction`) are accepted only as JSON captured from a
  **prior MCP tool response** (e.g. `alza_profile`), executed by `AppActionExecutor`:
  same-origin + HTTPS, path allowlist (`/api/`, `/services/restservice.svc/`), GET/POST only,
  sensitive field-name blocklist (password/token/card/cvv/iban/payment...), one-time
  confirmation token for every mutation.
- Mutating or high-impact tools require a one-time token from `alza_prepare_mutation`
  (or the `alza_checkout_preview` token for the order flow). The token is single-use.
- OAuth stays PKCE authorization-code flow; credentials never enter the MCP.

## In-scope families (12)

catalog · account · profile/address · reviews · complaints · subscriptions · basket ·
delivery · checkout · payments · orders · attachments

Scope extension (new goal, 2026-09-08): the **web checkout API family** (`m.alza.cz` /
`www.alza.cz`, section 13) is documented alongside the mobile surface — mapped by live
Playwright network capture, not the APK. The mobile 12 families remain the primary scope;
web rows are labeled with their exposure state (documented vs. typed-tool candidate).

## Exposure summary

- **Typed tools**: `search_products`, `get_product`, `get_product_reviews`,
  `find_pickup_points`, `list_categories` (browser catalog — registered without the `alza_` prefix);
  `alza_auth_discovery`, `alza_auth_start`, `alza_auth_exchange`, `alza_account_status`
  (auth); `alza_cart`, `alza_add_to_cart`, `alza_delivery_options`, `alza_select_pickup_point`,
  `alza_checkout_preview`, `alza_place_order` (basket/checkout); `alza_profile`,
  `alza_contacts`, `alza_register`, `alza_address_upsert`, `alza_address_delete`,
  `alza_address_search` (user management); `alza_payment_methods`, `alza_after_order_payments`,
  `alza_pay_after_order` (payments); `alza_order` (orders); `alza_review_submit`,
  `alza_complaint_claims`, `alza_subscription_overview`, `alza_subscription_activate`,
  `alza_subscription_update_installment`, `alza_upload_attachment` (reviews/complaints/
  subscriptions/attachments); `alza_web_pickup_places` (web pickup family, read-only);
  `alza_web_place_order`, `alza_web_pay_after_order` (legacy web WCF order + payment
  pipeline, one-time tokens — the verified submission path while mobile `sendOrder3`
  500s; gap-analysis G1).
- **Whitelists**:
  - `alza_mobile_read` — 38 read operations: `search`, `category`, `facets`, `legacy_product`,
    `router_product`, `alternatives`, `ean_lookup`, `hierarchical_filter`, `url_info`,
    `catalog_user_navigation`, `visitor_navigation`, `user_navigation`, `user_data`,
    `contacts`, `premium_trial`, `validate_login_name`, `validate_isic`, `o3_info`,
    `order2_info`, `order_add_info`, `cost_estimate`, `basket_info`, `cart`,
    `delivery_countries`, `branches`, `zip_codes`, `commodity_lists`, `commodity_list`,
    `discussion_posts`, `user_review`, `after_order_payments`, `user_order`, `order_part`,
    `anonymous_orders`, `anonymous_order`, `quick_order_summary`, `order_helpdesk_questions`,
    `web_after_payment_dialog` (2026-09-08: WCF `GetAfterPaymentDialog` read, row PA8).
  - `alza_prepare_mutation` + `alza_mutate_list` — 29 guarded mutations. Low-risk (18, executed
    via `alza_mutate_list`): `create`, `rename`, `delete`, `add`, `remove`, `move` (shopping
    lists), `set_country`, `set_isic`, `add_gift`, `add_order_service`, `set_watchdog`,
    `send_feedback`, `submit_discussion`, `rate_discussion`, `coupon_add`, `coupon_remove`,
    `basket_update`, `basket_unlock`. High-impact (11, executed via the matching typed tool):
    `register` → `alza_register`; `address_create`/`address_edit` → `alza_address_upsert`;
    `address_delete` → `alza_address_delete`; `after_order_payment` → `alza_pay_after_order`;
    `review_submit` → `alza_review_submit`; `subscription_activate` →
    `alza_subscription_activate`; `subscription_update_installment` →
    `alza_subscription_update_installment`; `attachment_upload` → `alza_upload_attachment`;
    `web_place_order` → `alza_web_place_order`; `web_after_order_payment` →
    `alza_web_pay_after_order` (2026-09-08, gap-analysis G1).
  See the family matrices below.

---

## 1. Catalog

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Catalog search | POST | `/services/restservice.svc/v5/search` | `{searchTerm, id:0, type:"PRODUCTION", typeId:0, orderBy, page, availabilityType, selectedBranches:[], params:[], producers:[], sendPrices:false}` (APK-confirmed body) | Paged product list | none | none | Typed `alza_search_products` (browser) + whitelist `search` (mobile) | `live-verified` (mobile read journey) |
| C2 | Category tree node | GET | `/services/restservice.svc/v1/category/{id}?type={TYPE}&typeId={id}` | `type` (e.g. `CATEGORY`), `typeId` (APK correction: both params, not path) | Category with children | none | none | Whitelist `category` | `source-confirmed` |
| C3 | Facets / parameter list | GET | `/services/restservice.svc/v3/params/{id}?type=&typeId=&search=` | filter search term optional | Facet groups | none | none | Whitelist `facets` | `live-verified` (read journey) |
| C4 | Product detail (external) | GET | `/api/legacy/catalog/v14/external/product/{id}` | product id | Full product incl. hypermedia actions (`commodityDiscussionAction`, `writeReviewAction`, `ratingAction`, delivery-time forms) | none | none | Typed `alza_get_product` (browser) + whitelist `legacy_product` | `live-verified` |
| C5 | Product detail (legacy, query params) | GET | `/api/legacy/catalog/v14/product/{id}?pgrik=&ucik=&country=&electronicContentOnly=` | optional branch/tenant params | Product detail | none | none | Whitelist `legacy_product` (params) | `source-confirmed` |
| C6 | Router product detail | GET | `/api/router/legacy/catalog/product/{id}` | same as C5 | Product detail | none | none | Whitelist `router_product` | `source-confirmed` |
| C7 | Alternatives | GET | `/services/restservice.svc/v1/alternatives/{commodityId}` | commodity id | Alternatives list | none | none | Whitelist `alternatives` | `live-verified` (read journey) |
| C8 | Products by EAN list | POST | `/services/restservice.svc/v1/getProductByEANlist` | `{eanList: string[]}` | Products by EAN | none | none | Whitelist `ean_lookup` | `source-confirmed` |
| C9 | Hierarchical filter | POST | `/services/restservice.svc/v1/hierarchicalFilter` | filter tree payload (server-echoed) | Filtered results | none | none | Whitelist `hierarchical_filter` | `source-confirmed` |
| C10 | URL info | POST | `/api/catalog/v1/homePage/getUrlInfo` | `{url}` (Alza URL string, not a user-supplied fetch target) | Resolved catalog node | none | none | Whitelist `url_info` | `live-verified` (read journey) |
| C11 | Catalog home navigation | GET | `/api/catalog/v2/homePage/userNavigation` | none | Navigation tree | none | none | Whitelist `catalog_user_navigation` | `live-verified` |
| C12 | Catalog home category carousel | GET | `/api/catalog/v1/homePage/categories/1/...` (fragment) | route fragment confirmed in error-handler; full sub-path built at runtime | Category carousel | none | none | `unresolved` — fragment only; not exposed until the full route is confirmed | `unresolved` |
| C13 | Visitor navigation | GET | `/api/visitors/{visitorId}/mainNavigation` | MCP-generated visitor id | Visitor nav | none | none | Whitelist `visitor_navigation` | `live-verified` |
| C14 | Authenticated user navigation | GET | `/api/users/{userId}/mainNavigation?eshopUrl=` | user id (from token) | Auth nav incl. order/complaint/subscription actions | auth | none | Whitelist `user_navigation` | `source-confirmed` |

## 2. Account

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| A1 | OIDC discovery | GET | `https://identity.alza.cz/.well-known/openid-configuration` | none | Discovery doc | none | none | Typed `alza_auth_discovery` | `live-verified` |
| A2 | OAuth authorize (PKCE) | GET | `https://identity.alza.cz/connect/authorize?...S256` | client `alza_Android`, scope `email openid profile alza offline_access`, redirect `alza://identity` | Browser auth (outside MCP) | none | creates auth session | Typed `alza_auth_start` | `live-verified` (PKCE flow) |
| A3 | OAuth token exchange | POST | `https://identity.alza.cz/connect/token` | `code` + `code_verifier` + `client_id=alza_Android` + `client_secret` (APK-embedded, source-verified: the client is **confidential** — requests without the secret get HTTP 400 `invalid_client`; the secret is the AES-Nk5-CBC/zero-IV decryption of an embedded 32-byte hex blob, 32-char ASCII, identical in 2026.15/2026.17; decoded by `scripts/alza-client-secret.mjs`) | access/refresh tokens (kept in MCP memory only) | A2 | in-memory tokens | Typed `alza_auth_exchange` | `source-confirmed` (client-auth live-verified: dummy code + secret → `invalid_grant`) |
| A4 | Token refresh (internal) | POST | same token endpoint, `grant_type=refresh_token` | refresh token (in-memory) | new access token | A3 | in-memory rotation | Internal to `MobileApi.request` (401 retry) | `source-confirmed` |
| A5 | User data (profile) | GET | `/services/restservice.svc/v2/getUserData` | none | `UserData`: personal data, address book with per-address actions, badges, sections | auth | none | Typed `alza_profile` + whitelist `user_data` | `live-verified` (authenticated journey) |
| A6 | Contacts | GET | `/services/restservice.svc/v4/contacts` | none | Contact list | auth | none | Typed `alza_contacts` + whitelist `contacts` | `live-verified` |
| A7 | Premium trial status | GET | `/api/user/{userId}/v1/alzapremium/trial` | user id | Trial status | auth | none | Whitelist `premium_trial` | `source-confirmed` |
| A8 | Login-name validation | GET | `/services/restservice.svc/v1/validateLoginName?email=` | email | availability | none | none | Whitelist `validate_login_name` | `source-confirmed` |
| A9 | ISIC card validation | POST | `/services/restservice.svc/v2/validateIsic` | `{cardNumber, name}` | validity | none | none | Whitelist `validate_isic` | `source-confirmed` |
| A10 | o3Info | GET | `/services/restservice.svc/v2/o3Info` | none | O3 (order-service) info; response shape not modeled in APK | none | none | Whitelist `o3_info` | `source-confirmed` (response shape `unresolved`) |
| A11 | Registration | POST | `/services/restservice.svc/v2/CreateUser` | `Register` DTO `{email, phone, pwd, code?}` (code = email/phone verification code) | `BaseResponseData` (created user) | none | **creates an external account** (high-impact, credential-bearing) | Typed `alza_register` with one-time token | `source-confirmed` |
| A12 | Set country | POST | `/services/restservice.svc/v1/setCountry` | `{countryId}` | updated setting | auth | persists country | Whitelist mutation `set_country` | `source-confirmed` |
| A13 | Set ISIC | POST | `/services/restservice.svc/v1/setIsic` | `{isic}` | updated setting | auth | persists ISIC | Whitelist mutation `set_isic` | `source-confirmed` |
| A14 | Change password | dynamic | `changePasswordAction` / `passwordAction` (server-provided `AppAction.form`) | password + 2FA values | form result | auth + 2FA | credential mutation | `blocked` — dynamic action, credential-bearing; typed wrapper deferred (security boundary: no dynamic actions yet) | `blocked` |
| A15 | Two-factor setup | dynamic | `twoFactorAction` | SMS/phone values | 2FA state | auth | enables 2FA | `blocked` — dynamic action | `blocked` |
| A16 | Phone number update | dynamic | `phoneNumberAction` | phone + verification | updated contact | auth | persists phone | `blocked` — dynamic action | `blocked` |
| A17 | GDPR data | dynamic | `gdprInfoAction` | none | GDPR export link | auth | none | `blocked` — dynamic action (read; candidate for typed wrapper) | `blocked` |
| A18 | Delete account | dynamic | `deleteAccountAction` / `deleteUserAccountAction` | confirmation values | account deleted | auth + 2FA | **account deletion (irreversible)** | `blocked` — dynamic, high-impact | `blocked` |
| A19 | Admin login | POST | `api/identity/v1/login/LoginUserAdmin` | admin credentials | admin session | admin | session | **Out of scope** (administrative) | n/a |
| A20 | Identity audit log | POST | `api/log/v1/identity/audit` | audit event | ack | auth | log write | **Out of scope** (telemetry) | n/a |

## 3. Profile / Address

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| P1 | Address book (list + actions) | GET | part of A5 `getUserData` | none | addresses (`UserDeliveryAddressWithActions`: id, name, firm, street, city, zip, phone, email, note, `UserAddressType` HOME/WORK/OTHER) with `createAddressAction`, per-address `formUpdate`/delete actions | auth | none | Typed `alza_profile` (returns the address section verbatim) | `live-verified` |
| P2 | Create address | dynamic | `createAddressAction` (form in A5 response) | typed subset `{name, street, city, zipCode, firm?, phone?, email?, note?, addressType?}` (APK `LoadedState` fields: name, firm, street, city, zipCode, phone, email, note, `UserAddressType`) | form result (new address) | auth | **persists a delivery address** | Typed `alza_address_upsert` (action create) with one-time token | `source-confirmed` |
| P3 | Edit address | dynamic | per-address `formUpdate` action (A5 response) | same typed subset + `addressId` | form result | auth | persists address | Typed `alza_address_upsert` (action edit) with one-time token | `source-confirmed` |
| P4 | Delete address | dynamic | per-address delete action (A5 response) | `addressId` | form result | auth | **removes a delivery address** | Typed `alza_address_delete` with one-time token | `source-confirmed` |
| P5 | Address search/autocomplete | dynamic | `addressSearchAction` (A5 response) | zip/city query | address suggestions | auth | none | Typed `alza_address_search` (read, no token) | `source-confirmed` |
| P6 | Delivery address selection (checkout) | POST | `/services/restservice.svc/v4/getDeliveryAssociations` | `DeliveryPaymentAssociation` payload from current delivery response | associations | cart + delivery step | selects address/AlzaBox | Typed `alza_select_pickup_point` | `source-confirmed` |
| P7 | Delivery variants / time frames | dynamic | `DeliveryVariantsActions`, `DeliveryTimeItemsWithForm`, `DeliveryHoursActions` (product-detail / address forms) | form values | delivery options | product/address context | none | `blocked` — dynamic forms; the typed `alza_delivery_options` covers the static payment-group read | `blocked` |
| P8 | Personal (home) delivery scheduling | dynamic | `cz.alza.base.api.delivery.personal` action set | time-frame values | scheduled delivery | address | persists preference | `blocked` — dynamic action family | `blocked` |

## 4. Reviews

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| R1 | Read user product review | GET | `/api/users/{flag}/commodities/{flag}/review` | two boolean flags from the APK (`i==true?1:0`), not ids (correction of earlier `user_review` doc: first flag = user scope, second = commodity scope) | user's review or empty | auth (flag) | none | Whitelist `user_review` (flags) | `source-confirmed` (flag semantics from APK v38.java) |
| R2 | Write product review | dynamic | `writeReviewAction` form from C4 product detail (`LoadWriteReviewFormUseCase`); submit via the form's `meta.href` | `WriteReview` values (rating, text, ...) from the loaded form | `WriteReview` response | product detail form loaded | **publishes a review** | Typed `alza_review_submit` with one-time token | `source-confirmed` (form-driven, route server-provided) |
| R3 | Discussion post list | GET | `commodityDiscussionAction` from C4 (app follows the action; legacy path `/services/restservice.svc/v1/getCommodityDiscussionPosts?id=&pageStart=&pageSize=` used by the web client) | commodity id, pagination | discussion posts | none | none | Whitelist `discussion_posts` | `live-verified` (read journey) |
| R4 | Submit discussion post | POST | `/services/restservice.svc/v1/submitCommodityDiscussionPost` | `{commodityId, msg, userEmail, anonymous, notifications, parentPostId?}` (`SendDiscussionPost`) | created post | none | **publishes a post** | Whitelist mutation `submit_discussion` | `source-confirmed` |
| R5 | Rate discussion post | GET | `/services/restservice.svc/v1/rateCommodityDiscussionPosts?id=&rating=` (APK: method constant = GET; query `id` + rating form name) | post id, boolean rating | ack | none | persists vote | Whitelist mutation `rate_discussion` | `source-confirmed` |
| R6 | Product rating action | dynamic | `ratingAction` from C4 | rating values | rating result | product | persists rating | `blocked` — dynamic form (review rating is part of the R2 form flow) | `blocked` |

## 5. Complaints

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| K1 | Warranty claims list | dynamic (read) | `activeWarrantyClaimsAction` / `showActiveWarrantyClaimsAction` (from authenticated navigation / order detail) | action from prior MCP response | `ClaimList` (claims with statuses) | auth | none | Typed `alza_complaint_claims` (read, no token) | `source-confirmed` |
| K2 | Claim / complaint detail | dynamic | claim detail action (server-provided, from K1) | claim id | `ClaimDetail`, `WarrantyClaimMessageBanner`, complaint items | auth | none | `blocked` — detail route is server-provided per claim; typed wrapper deferred | `blocked` |
| K3 | Complaint guide (return flow) | dynamic | `ComplaintGuide*` view states driven by server forms (delivery/place/product steps) | step values | guide steps | order | advances complaint draft | `blocked` — multi-step dynamic form; no static complaint-submission route exists in the APK (re-verified: no `complaint`/`reklamace` route constants) | `blocked` |
| K4 | Complaint attachments | dynamic (multipart) | `uploadImageAction` / `ComplaintAddAttachment` (multipart form values with `FileUpload {fileName, mimeType, maxUploadSize, uri}`) | attachment files + claim context | uploaded attachment refs | claim draft | **uploads files** | Typed `alza_upload_attachment` (multipart, one-time token) | `source-confirmed` |
| K5 | Complaint banner / items | dynamic | `ComplaintBanner`, `ComplaintItems` from order detail | — | display data | order | none | Documented as read data inside order responses (no separate route) | `source-confirmed` |

## 6. Subscriptions

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| S1 | AlzaSubscription overview | dynamic (read) | `subscriptionAction` (account menu / authenticated navigation) | action from prior MCP response | `AlzaSubscriptionOverview` (phases, savings, trial settings) | auth | none | Typed `alza_subscription_overview` (read, no token) | `source-confirmed` |
| S2 | Premium trial status | GET | A7 route | user id | trial status | auth | none | Whitelist `premium_trial` | `source-confirmed` |
| S3 | Activate subscription | dynamic | `activateAction` (subscription form) | form values (payment context) | activated subscription | auth + payment method | **starts a paid subscription** | Typed `alza_subscription_activate` with one-time token | `source-confirmed` |
| S4 | Update installment plan | dynamic | `updateInstallmentAction` | installment values; response `RecalculatedDetails` | recalculation | active subscription | **changes payment schedule** | Typed `alza_subscription_update_installment` with one-time token | `source-confirmed` |
| S5 | Limit-exceeded repayment | dynamic | `limitExceededRepaymentAction` | repayment values | repayment result | failed installment | charges card | `blocked` — high-impact dynamic action; documented | `blocked` |

## 7. Basket

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| B1 | Cart grid read | GET | `/services/restservice.svc/v10/gridOrder1` | none | cart line items | none | none | Typed `alza_cart` (items) | `live-verified` (read journey) |
| B2 | Basket info | GET | `/services/restservice.svc/v3/basketInfo` | none | basket summary | none | none | Typed `alza_cart` (info) + whitelist `basket_info` | `live-verified` |
| B3 | Add product by code | POST | `/services/restservice.svc/v2/basket/add` | `{code, amount}` (BuyByCode) | updated basket | none | **adds to cart** | Typed `alza_add_to_cart` | `live-verified` (E2E journey: added product `FKP0383232` 2026-09-06, authenticated + guest) |
| B4 | Basket update (delayed payment flag) | GET | `/services/restservice.svc/v2/updBasket/{basketId}/{flag}?isDelayedPayment=` (APK correction: GET, no body) | basket id, flag, delayed-payment flag | updated basket | cart | mutates basket | Whitelist mutation `basket_update` | `source-confirmed` |
| B5 | Unlock basket | POST | `/services/restservice.svc/v1/unlockbasket` | none | unlocked | locked cart | clears lock | Whitelist mutation `basket_unlock` | `source-confirmed` |
| B6 | Add coupon | GET/POST | `/services/restservice.svc/v1/addcoupon/{code}` | coupon code | coupon result | cart | **applies discount** | Whitelist mutation `coupon_add` | `source-confirmed` |
| B7 | Remove coupon | GET/POST | `/services/restservice.svc/v1/delcoupon/{code}` | coupon code | coupon result | cart | removes discount | Whitelist mutation `coupon_remove` | `source-confirmed` |
| B8 | Add gift | POST | `/services/restservice.svc/v2/addGift` | `{rangeIdsGiftCodes: [{priceRangeId, giftCodes[]}]}` | gift result | cart | adds gift | Whitelist mutation `add_gift` | `source-confirmed` |
| B9 | Price watchdog | POST | `/api/watchdog/v1` | `{commodityId, email, isTrackingStock, price?}` | watchdog entry | none | **creates tracking** | Whitelist mutation `set_watchdog` | `source-confirmed` |
| B10 | Shopping lists (read) | GET | `/services/restservice.svc/v1/getCommodityLists[/{id}][?type=]` | optional list id/type | lists | auth | none | Whitelist `commodity_lists`, `commodity_list` | `live-verified` |
| B11 | Shopping list mutations | POST | `createCommodityList` / `renameCommodityList` / `deleteCommodityList` / `v2/addCommodityToList` / `v2/deleteCommodityFromList` / `v2/moveCommodityToList` | list DTOs (APK-confirmed field sets) | list result | auth | list CRUD | Whitelist mutations `create/rename/delete/add/remove/move` | `source-confirmed` |
| B12 | Device token registration | POST | `/services/restservice.svc/v2/setDeviceToken` | token | ack | none | stores push token | **Out of scope** (device-token) | n/a |

## 8. Delivery

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| D1 | Delivery + payment groups | GET | `/services/restservice.svc/v13/getDeliveryPaymentGroups[?selectedDeliveryOptionId=]` (app 2026.17 uses **v13**; v12 still served live in parallel — both verified 2026-09-07; **since 2026-09-08 the typed tools call v13 with a v12 fallback on HTTP 404 — gap-analysis G2 closed**; v13 re-verified served 2026-09-07 and 2026-09-08) | optional selected delivery id | delivery options + payment methods; 2026.17 response models add `afterSelectAction`/`afterDeselectAction` (server-driven follow-up AppActions on `Delivery`/`Payment` items), `Payment.isConditionalFreeDelivery`, `CardPayment.hideStoredPaymentCards` | cart | none | Typed `alza_delivery_options` + `alza_payment_methods` (payment projection) | `live-verified` (E2E journey: AlzaBox option 2680 + parcel-shop 1128203 resolved from the D2 associations; payment groups incl. proforma 103; v13 re-verified 2026-09-07 and 2026-09-08) |
| D2 | Delivery associations (AlzaBox/point selection) | POST | `/services/restservice.svc/v4/getDeliveryAssociations` | `DeliveryPaymentAssociation` (from D1 response) | associations | cart | selects pickup point | Typed `alza_select_pickup_point` | `source-confirmed` |
| D3 | Delivery countries | GET | `/services/restservice.svc/v1/getAllDeliveryCountries` | none | countries | none | none | Whitelist `delivery_countries` | `live-verified` |
| D4 | City branches | GET | `/api/branches/v1/cityBranches?latitude=&longitude=` | coordinates | branches | none | none | Whitelist `branches` | `live-verified` |
| D5 | Zip codes | GET | `/services/restservice.svc/v1/getZipCodes?deliveryId=0[&search=]` | optional search | zips | none | none | Whitelist `zip_codes` | `live-verified` |
| D6 | Delivery time/variants forms | dynamic | P7/P8 action families | form values | time frames | address | persists choice | `blocked` — dynamic forms (see P7/P8) | `blocked` |

## 9. Checkout

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| O1 | Checkout state step 1 | GET | `/services/restservice.svc/v4/sendOrder1` | none | checkout state (cart content step; **not** submission — correction) | cart | none | Typed `alza_checkout_preview` (state) | `source-confirmed` |
| O2 | Select delivery + payment | POST | `/services/restservice.svc/v7/sendOrder2` | `SelectedDeliveryPayment` (APK `SelectedDelivery` shape — see Corrections) | selected | preview token | selection | Typed `alza_place_order` (step 1) | `live-verified` (E2E journey 2026-09-06: delivery registered, err:0, `register_type:20`) |
| O3 | User info step | POST | `/services/restservice.svc/v5/sendOrder3` | `SendOrderUserInfo {parameters: Parameters}` (APK-confirmed `Parameters` fields: `newUserInfo`, `billingInfo {fName,fStreet,fCity,fZip,fEmail,fPhone}`, `companyInfo`, `deliveryAddress {dName,dStreet,dCity,dZip,dEmail,dPhone}`, `email`, `note`, `info`, `confirmPwd`, `eduId`, `icDph`, `bic`, `iban`, `bankAccountOwnerName`) | user info result | O2 | persists checkout user data | Typed `alza_place_order` (step 2) | `live-verified` — live-reached (guest `newUserInfo`, authenticated empty and full `Parameters` shapes) but returns **HTTP 500 `InternalServerError`** in every tested state (2026-09-06, authenticated + guest, delivery registered; **re-confirmed 2026-09-08** — full + empty `Parameters` both 500, `docs/live-evidence/gap-recheck-2026-09-08.md`): server-side gap, `unresolved`; see the complete E2E record |
| O4 | Approve order | GET/POST | `/services/restservice.svc/v1/approveOrder4` | none | approval | O3 | prepares submission | Typed `alza_place_order` (step 3) | `source-confirmed` |
| O5 | Finish order | POST | `/api/orders/v7/orderfinished` | `SendCompleteOrder` (APK: `{cardId?, deviceFingerprint?, consents: Consent[], basketConsents: Consent[]}`, `Consent {consentId, value}`) | created order | O4 | **creates the order** | Typed `alza_place_order` (step 4) | `source-confirmed` (mobile step 4 is unreachable while O3 500s; live order creation is recorded through the legacy web WCF chain WCF1–WCF5 below — see the complete E2E record) |
| O11 | Legacy web WCF checkout pipeline | POST | `/Services/EShopService.svc/{LeaveOrder1,SaveOrder2,SaveOrder3,SaveAndConfirmOrder2,CheckOrder4,SendOrder4,VerifyUser,GetZipCodes}` — the pipeline the live www.alza.cz Order1/2/3.htm checkout actually uses. **Complete operation inventory (2026-09-08 live probe, 92 candidate names POSTed in-browser): exactly 10 exist** — the 8 in the route column above + `GetAfterPaymentDialog` + `CreateAfterPayment` (rows PA8/PA9); the other 82 probed names (LeaveOrder2–4, SaveOrder1/4, CheckOrder1–3/5, SendOrder1–3/5, GetOrder*/Cancel*/Coupon*/Pickup*/Invoice* variants, …) all return HTTP 404 — the WCF order+payment family is **closed**. All responses carry the standard envelope `{d:{DevErrorMessage, Message, ErrorNeoPurchaseFailed, ErrorLevel, RedirectUrlOrderDetail, PaymentAction, CanShowFastCheckoutButton, LeasingPartnerUrl, …}}` | `SaveOrder2 {selectedDeliveriesForGroups:[{deliveryGroupId,deliveryId,parcelShopId,deliveryAccesoriesIds}],paymentId,deliveryZipCode,deliveryCity,paymentCardId,deliveryAddressId,alzaPlusSubscriptionId?,cetelemLeasingId?}`; `SaveOrder3 {registerUser,login,name,street,city,zip,phone,email,countryId,...}`; `SaveAndConfirmOrder2` = SaveOrder2 state (+`showAlzaPlusBadges`); `CheckOrder4 {}`; `SendOrder4 {quotation,internalDescription,verificationId,verificationCode,userConsents,basketConsents}` | per-step `ErrorLevel` (0 = ok); `SendOrder4` → `GetOrderDetailAction {webLink order-details-{id}.htm?x={hash}, href, appLink orderDetail}` | cart + registered selection | `SaveAndConfirmOrder2` first attempt can return **`ErrorLevel:113` + `alzaPlusPopupDialogAction`** (AlzaPlus promo gate — the web UI dismisses it with “Nemám zájem”, equivalent to the immediate retry → 0); `SendOrder4` **creates the order** | **Typed `alza_web_place_order`** (one-time token `web_place_order`; typed inputs + 113-retry built in, 2026-09-08, gap-analysis G1) | `live-verified` (2026-09-06 run created real orders 1056806231 / 1056807179 / 1056807586 / 1056808137; **2026-09-08**: 113 promo gate re-confirmed (`docs/live-evidence/gate113-recheck-2026-09-08.json`) and real order **1057075103** created through the exact `alza_web_place_order` chain with its real `CreateAfterPayment` 144 MojePlatba hand-off (`docs/live-evidence/web-tool-e2e-2026-09-08.md`) — live quirk noted: `SendOrder4` top-level `OrderId` is 0, the id lives in `GetOrderDetailAction`) |
| O6 | Order 2 info | GET | `/services/restservice.svc/v8/getOrder2Info` | none | checkout step data | cart | none | Whitelist `order2_info` | `source-confirmed` |
| O7 | Order add-info (gifts etc.) | GET | `/services/restservice.svc/v2/getOrderAddInfo?isGiftsEnabled=true` | none | add-info | none | none | Whitelist `order_add_info` | `live-verified` (read journey) |
| O8 | Cost estimate | POST | `/api/orders/v1/costEstimate` | cost-estimate request (product ids + delivery/payment context; non-card payload; card-referencing payloads stay `blocked` until the card DTO is verified) | `CostEstimateResult` (fees, totals) | cart | none (read-only calculation) | Whitelist `cost_estimate` | `source-confirmed` |
| O9 | Add order service | GET | `/services/restservice.svc/v1/addOrderService/{service}/{enabled}/{selected}` | service name, flags | service state | cart | toggles service | Whitelist mutation `add_order_service` | `source-confirmed` |
| O10 | Feedback | POST | `/services/restservice.svc/v1/feedback` | `{text, email?, info}` | ack | none | stores feedback | Whitelist mutation `send_feedback` | `source-confirmed` |

## 10. Payments

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| PA1 | Payment methods (with delivery) | GET | D1 route (`getDeliveryPaymentGroups`) | optional selected delivery id | delivery + **payment method groups** | cart | none | Typed `alza_payment_methods` (payment projection of D1) | `live-verified` (E2E journey: method groups listed, incl. proforma 103 — same live data as D1) |
| PA2 | After-order payment options | GET | `/services/restservice.svc/v2/getafterorderpayments/{orderId}/{partId}` | order + part id | available after-order payment methods/options | order (unpaid) | none | Typed `alza_after_order_payments` (read) | `live-verified` (2026-09-06, real order 1056808137: 200 `err:1` `“Faktura se zadaným ID neexistuje”` — the mobile invoice lookup covers restservice-pipeline orders; WCF-created orders are documented as out of that lookup; see the complete E2E record) |
| PA3 | After-order payment execution | POST | `/api/orders/v4/afterOrderPayment` | `AfterOrderRequestBody {id, invoiceNumber, paymentId, cardId?, deviceFingerprint?}` (APK-confirmed DTO) | `OrderPaymentResponse {orderNumber, urlNext, gaPrice, gaVat, gaDeliveryPrice, next (AppAction), nextNavStep}` + `BaseResponse` fields | order (unpaid) + paymentId from PA2 | **charges the payment method (money movement — high-impact)** | Typed `alza_pay_after_order` with one-time token | `live-verified` (2026-09-06, real order: 200 `err:1` `“Aktualizujte prosím aplikace”` for WCF-created orders across paymentIds 2/4/103/143/144, with/without Bearer, UA 2026.15/17 — documented limitation; the web after-payment execution `CreateAfterPayment` (WCF8) ran for real: MojePlatba → KB SSO gateway; **both `err:1` behaviors re-confirmed 2026-09-08** against the still-open order 1056808137, `docs/live-evidence/gap-recheck-2026-09-08.md`) |
| PA8 | After-payment dialog (web) | POST | `/Services/EShopService.svc/GetAfterPaymentDialog` | `{orderId, invoiceId, price, isPartialPay, isSwitchToCashAvailable, orderHash}` | HTML dialog “Zaplatit objednávku” with the after-order payment methods (live: Apple Pay 213, Kartou online 216/Adyen, Google Pay 219, Platba 24 143, MojePlatba 144, Kryptoměnou 203) + amount | unpaid order + hash | none (read) | Whitelist read `web_after_payment_dialog` (2026-09-08) | `live-verified` (2026-09-06, order 1056808137) |
| PA9 | After-payment execution (web) | POST | `/Services/EShopService.svc/CreateAfterPayment` | `{orderId, paymentId, hash, enableAD, invoiceId, price, smsCode, smsId, isTrusted, amountToPay, headerId, orderPaymentId}` | gateway hand-off (redirect to the selected provider) | unpaid order + paymentId (PA8 dialog) | **initiates the payment (money movement — high-impact)** | Typed `alza_web_pay_after_order` (one-time token, 2026-09-08; the mobile PA3 stays the mobile exposure) | `live-verified` (2026-09-06: paymentId 144 MojePlatba → redirect `https://login.kb.cz/login?sso=MojePlatba-1189` KB SSO) |
| PA10 | QR instant-payment data | GET | `/api/v1/orders/{orderId}/{hash}/qrPayment?isOrderNumberSpecified=true&country=CZ` | none | SPayD payment string (`SPD*1.0*ACC:CZ56...`), bank account, variable symbol, amount, payment date | unpaid order | none (read) | Documented | `live-verified` (2026-09-06, order 1056808137: 104 CZK instant-payment QR) |
| PA11 | Payment via bank app (client-side UX) | — (no new endpoint) | APK `PayViaBankAppResolver` (`cz.alza.base.lib.order.utils`): resolves whether a bank app (e.g. MojePlatba/Platba 24) is installed and drives the after-order payment through the app's deep link; 2026.17.0 (Sep 3, 2026) adds the **preferred-bank-app preference** (`SetDefaultBankApp` analytics event, `isBankAppOnboardingEnabled` flag) and `qrCodeResultReceiver` (handles the bank app returning a QR result) | `OrderPayViaBankApp` / `OrderDirectPayViaBankApp` / `OrderSetupDirectPayViaBankApp` screens (present since 2026.15) | the after-order payment method list (PA2/PA9) unchanged at API level — the bank app is a client-side channel for the same `paymentId` flow | unpaid order + bank app installed | initiates the payment via the bank app (money movement) | Documented (app UX; no new MCP surface — the API-level flow stays PA2/PA3/PA9) | `source-confirmed` (APK 2026.17 re-audit 2026-09-07; release notes: “option to set a preferred application for bank payments”) |
| PA4 | Payment order-detail action (Box2Box) | dynamic | `v3/payment/getOrderDetailAction` href template (Box2Box order models) | order context | payment detail actions | Box2Box order | none | `blocked` — server-provided action; documented in the dynamic-action registry | `blocked` |
| PA5 | Klarna hand-off | dynamic | external `payments.klarna.com` session (`KlarnaSession`) | Klarna params | external session | order | external redirect | `blocked` — leaves Alza origin (security boundary); documented | `blocked` |
| PA6 | Google Pay | dynamic | `GooglePayRequest` (provider hand-off) | Google Pay params | token/charge | order | external charge | `blocked` — external provider flow | `blocked` |
| PA7 | Quick-order payment | dynamic | `SubmitQuickOrder` (quick-order action family) | `QuickOrderBuyInfo` + stored payment methods | `QuickOrderSubmitResult` (created/reservation) | quick-order context | **creates + pays a quick order** | `blocked` — dynamic quick-order family (documented; high-impact) | `blocked` |

## 11. Orders

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| OR1 | User order read | GET | `/api/users/{flag}/v1/orders/{orderId}?initialCreated=1` | user flag (0/1), order id | order incl. parts, `OrderPartMilestones` (tracking), `Document` (invoice refs), complaint fields | auth | none | Typed `alza_order` (order + part detail) + whitelist `user_order` | `live-verified` (2026-09-06: real orders read through the anonymous user-order API after the E2E submission) |
| OR2 | Order part read | GET | `/api/v1/orders/{orderId}/{partId}` | ids | part detail | none | none | Typed `alza_order` (part) + whitelist `order_part` | `live-verified` (2026-09-06: part `1070772578` of order 1056808137 read via `/api/anonymous/v1/orders/1056808137` → parts) |
| OR11 | Order cancellation | GET+PUT | `GET /api/v1/orders/{id}/{hash}/parts/{partId}/cancelForm` (HATEOAS form: `method:PUT`, fields `reason` [0–5] + `submit`, `rel:["create-form"]`, `href: .../cancellations`) → `PUT /api/v1/orders/{id}/{hash}/parts/{partId}/cancellations` (body `{"value":[<form fields with reason set>]}`) | cancel reason | `202 Accepted`; order status “Objednávka byla zrušena” | unpaid order + hash | **cancels the order** | Documented (order family) | `live-verified` (2026-09-06: cancelled 1056806231 + 1056807586) |
| OR12 | Order hash link | POST | `/api/anonymous/v1/orders/{orderId}/hashRequests` (form from `GET .../hashDialog`) | none | e-mail with the `?x=<hash>` details link to the purchase address | hashless order | sends e-mail | Documented | `live-verified` (2026-09-06, “Zkontrolujte prosím e-mail”) |
| OR3 | Anonymous order read | GET | `/api/anonymous/v1/orders/{orderId}` or `?invoiceNumber=` | order/invoice id | order | none | none | Whitelist `anonymous_orders`, `anonymous_order` | `live-verified` (read journey) |
| OR4 | Helpdesk questions | GET | `/api/orders/v1/helpdesk/questions` | none | questions | none | none | Whitelist `order_helpdesk_questions` | `live-verified` |
| OR5 | Quick-order summary | GET | `/api/users/{userId}/v1/quickOrder/summary/commodities/{commodityId}[?pgrik=&ucik=]` | user + commodity | quick-order summary | auth | none | Whitelist `quick_order_summary` | `source-confirmed` |
| OR6 | Order search | dynamic | `searchOrdersAction` | search params | `OrderSearchResult` | auth | none | `blocked` — dynamic action (documented; typed wrapper candidate) | `blocked` |
| OR7 | Order archive | dynamic | `archiveOrdersAction` | order refs | archived | auth | archives | `blocked` — dynamic action | `blocked` |
| OR8 | Order data update / recalculation | dynamic | `updateOrderDataAction`, `recalculationAction` | form values | updated order | order | mutates order | `blocked` — dynamic, high-impact | `blocked` |
| OR9 | Cancel drop order (AlzaBox) | dynamic | `cancelDropOrder` dialog flow (`CancelDropOrderDialogResponse`) | confirmation values | cancelled drop order | AlzaBox order | **cancels an order** | `blocked` — dynamic, high-impact | `blocked` |
| OR10 | Invoice / document download | dynamic | `Document` refs inside order responses + `downloadAction` | document ref | file | order | none | `blocked` — download follows a server-provided URL; typed wrapper candidate (origin-validated) | `blocked` |

## 12. Attachments

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| AT1 | Attachment upload (multipart) | dynamic (multipart) | `uploadImageAction` / complaint attachment actions (multipart `Form` values; `FileUpload {fileName, mimeType, maxUploadSize, uri}`) | attachment values + claim/context action | uploaded attachment refs | claim draft / form | **uploads files** | Typed `alza_upload_attachment` (multipart executor path, one-time token) | `source-confirmed` |
| AT2 | Attachment listing | dynamic | `ComplaintAttachment(attachmentName=...)` inside claim/complaint detail | — | attachment names | claim | none | Documented inside K2/K4 responses (no separate route) | `source-confirmed` |
| AT3 | Vision (receipt/photo analysis) | dynamic | `cz.alza.base.api.vision` (server-driven) | image + context | analysis result | none | none | `unresolved` — no static route in APK source (vision API is server-configured); documented, not exposed | `unresolved` |

---

## 13. Web checkout (m.alza.cz / www.alza.cz, React + GWT hybrid)

The 2026-09-08 goal extension: the web checkout on `m.alza.cz` is a Next.js/React app
(Tailwind, Material-UI dialogs) that mixes a **new HATEOAS REST family** ("appAction"
responses with `self.href` + `appLink`) with the **same WCF services as the mobile app**
(`m.alza.cz` hosts its own `EShopService.svc` + `restservice.svc`). Page flow:
`Order1.htm` (cart) → **LeaveOrder1** → `Order2.htm` (delivery + payment, pickup dialogs)
→ Order3 (user info + payment; **`Order4.htm` is a 404 on m.alza.cz** — the web mobile UI
is 3-step, payment happens on step 3). `Order3.htm` redirects to `Order2.htm` until a
delivery method is registered in the WCF state (`getOrderAddInfo.addInfo.max_step` gate).
Mapped by live Playwright capture 2026-09-07/08 (digest:
`docs/live-evidence/web-checkout-mcz-digest.json`; raw logs `/tmp/mcz-checkout1..8.json`).

| # | Operation | Method | Route | Input / DTO | Response | Prerequisites | Side effects | Exposure | Status |
|---|---|---|---|---|---|---|---|---|---|
| W1 | Next.js session bootstrap | GET | `m.alza.cz/next-api/auth/get-session` | none (cookie session) | session JSON | none | none | Documented (framework plumbing; not an MCP surface) | `live-verified` (2026-09-08 capture) |
| W2 | Visitor status | GET | `/api/visitors/{visitorId}/statusSummary` | MCP/browser visitor id | visitor status summary | visitor cookie | none | Documented | `live-verified` |
| W3 | Cart (HATEOAS) | GET | `/api/v1/visitors/{visitorId}/baskets/{basketId}/checkout/cart?country=CZ` | visitor + basket id | `{maxStep, sameDayDeliveryMessage, itemsAction {href, appLink "BasketCheckoutCartItems"}, emptyCartAction, …}` | visitor cart | none | Documented (typed-tool candidate for the web family) | `live-verified` |
| W4 | Cart items (HATEOAS) | GET | `/api/v1/anonymous/baskets/{basketId}/checkout/cart/items?country=CZ` | basket id | `{items:[{productId, count, basketItemId, updateQuantityAction {href, appLink "basketItemUpdate"}, isDelayedPayment}]}` | visitor cart | none | Documented | `live-verified` |
| W5 | Add to cart (web) | POST | `www.alza.cz/api/basket/v1/items` | product code (page-driven) | HATEOAS cart state with appActions | none | **adds to cart** | Documented (the mobile typed path is B3 `basket/add`; web route recorded for the family) | `live-verified` (capture: add of `zviratka-d5303619` created the guest basket) |
| W6 | Basket announcements | GET | `/api/basket/v1/announcements?includeAlzaPlusAnnouncement=` ; `webapi.alza.cz/api/anonymous/v1/basket/annoucements/alzaPlusBanner` (note the server-side `annoucements` typo) | none | announcement payloads | none | none | Documented | `live-verified` |
| W7 | Cookie-consent groups | GET | `/api/Cookies/v1/groups` | none | `{self, groups:[]}` (HATEOAS) | none | none | Documented | `live-verified` |
| W8 | Web navigation (incl. parcel-locker checkout action) | GET | `/api/navigation` ; `/api/anonymous/v1/navigation` (response carries a `parcelLockers` action → `GET /api/anonymous/v1/orders/checkout/parcelLockers`) | none | navigation trees + actions | none | none | Documented | `live-verified` |
| W9 | Order state (WCF, m.alza.cz host) | GET | `m.alza.cz/services/restservice.svc/v2/getOrderAddInfo` | none | `{addInfo:{types, max_step}, basket_cnt, user_id, vzt, serverTime, premium*}` — `max_step` gates the Order2→3 transition | visitor basket | none | Documented (same WCF restservice family as mobile A10/O7, served on the web host) | `live-verified` |
| W10 | LeaveOrder1 (Order1→Order2 transition) | POST | `m.alza.cz/Services/EShopService.svc/LeaveOrder1?showVoucherDialog={true|false}` | none (WCF state in cookies) | 200 (page advances) | cart | advances the WCF checkout state machine | Documented (m.alza.cz hosts its own `EShopService.svc` — same O11 WCF family; proves the web host serves the mobile-style WCF) | `live-verified` (200 in 5 captures) |
| W11 | Pickup-place availability form | GET | `/api/personalPickup/v1/pickupPlaceForm?orderId={basketId}&groupId={gid}&latitude=&longitude=` | basket as `orderId`, delivery-group id, geo | `{self (appLink "pickupPlaceForm"), types:[{type, name ("AlzaBox"/branches/24-7/…), description ("od 49 Kč"), count (~3970 boxes), groupId, isSelected, state, imgUrl}]}` | cart + group | none | Typed `alza_web_pickup_places` (read, no token; 2026-09-08, gap-analysis G3) | `live-verified` |
| W12 | Pickup map points | GET | `/api/personalPickup/v1/points?types[0]=&latitude=&longitude=&orderId=&groupId=&radius=&ordering=&bbox-params…` | type filter, geo, radius, bbox | `{self (appLink "pickupPlaceMapPoints"), points:[], lines:[], hint}` | W11 | none | Documented | `live-verified` |
| W13 | Pickup list (paginated) | GET | `/api/personalPickup/v1/places?types[0]=&latitude=&longitude=&orderId=&groupId=&limit=20&offset=0&ordering=` | type filter, geo, paging | `{self (appLink "pickupPlaceList"), pickupPlaces:{…paged list}}` | W11 | none | Documented | `live-verified` |
| W14 | Pickup place detail | GET | `/api/personalPickup/v1/places/{placeId}?orderId={basketId}&groupId={gid}` | place id (e.g. `601` = Alza Hradec Králové branch) | `{self (appLink "pickupPlaceDetail"), id, deliveryId, parcelShopId, isFree, isChristmasGuaranteed, isPremium, typeText ("AlzaBranch"/"AlzaBox"/…), articleUrl, detailAction, state, detail:{standardPrice ("45 Kč"), openingHours:[{label, intervals[{label, openingHoursType}]}]}}` | W11–W13; **fires on place selection in the Order2 dialog** | registers/echoes the place selection state | Typed `alza_web_pickup_places` (`place_id` input; 2026-09-08; pairs with mobile D4 `/api/branches/v1/cityBranches`) | `live-verified` (place 601 detail captured) |
| W15 | Product page APIs (web) | POST/GET | `POST m.alza.cz/api/Article/Get` (article lookup); `GET m.alza.cz/Services/RestService.svc/v1/product/{id}/ribbon` (case-sensitive host path — note `Services`/`RestService` casing); `GET m.alza.cz/api/productAvailability/v1/anonymous/products/{id}`; `webapi.alza.cz`: `GET /api/carousels/v1/commodities/{id}/recommendedAccessorySlots \| purchasedTogether \| bestsellers`, `GET /api/catalog/v2/commodities/{id}/reviewStats \| reviews`, `GET /api/commodity/v2/{id}/buyActions`, `POST /api/commodities/v1/adCommodityView` (202) | product ids | carousels, reviews, buy-actions, ad view | none | none | Documented (web product-page family; mobile equivalents are C4–C6) | `live-verified` |
| W16 | Order2→3 transition (delivery registration) | POST | `SaveOrder2` (delivery + payment registration) then `SaveAndConfirmOrder2` (the 113 promo-gate retry path, O11) on the same `EShopService.svc` family — the 2026-09-08 probe **confirmed `LeaveOrder2`/`LeaveOrder3` are 404**: the *Save* operations themselves advance the WCF state machine (no separate Leave step exists) | O11 DTOs (delivery group + delivery + parcelShop + payment) | `ErrorLevel` 0 on success; `max_step` advances, Order3 unlocks | W10 + W14 | persists the delivery selection in the WCF state | Documented (family = O11; the 2026-09-06 E2E ran the identical chain on www.alza.cz) | `live-verified` (route-level 2026-09-08 probe: SaveOrder2/SaveAndConfirmOrder2 → 200; payload + 113-gate behavior live-verified 2026-09-06 via O11) |
| W17 | Order3 user info + payment (web) | POST | `SaveOrder3` / `SaveAndConfirmOrder2` / `CheckOrder4` / `SendOrder4` (O11 WCF family, m.alza.cz host) — the 3-step web UI ends with payment on step 3 (`Order4.htm` is a live 404 on m.alza.cz) | O11 DTOs | O11 per-step results; `SendOrder4` creates the order | W16 | **creates the order** | Documented (O11 covers the WCF pipeline; the 2026-09-06 E2E ran the same chain on www.alza.cz) | `live-verified` (via O11 on www; m.alza.cz host serves the same service — W10) |
| W18 | Chatbot (web) | GET/POST | `chatbotapi.alza.cz/api/visitors/{visitorId}/v1/navigation` ; `POST …/v1/chat {country, pageType (5=Order1, 6=Order2, 24=Order4…), forceInitialize, initialInput, referrer}` | page context | chatbot navigation / chat session | visitor | chat session | **Out of scope** (chat family — documented candidate for the gap report) | `live-verified` (documented) |
| W19 | Web telemetry | POST | `logapi.alza.cz/api/log/v2/logs` (React app, `appVersion 4.227.0`); `POST m.alza.cz/metrics/gs/ccm/collect` (GWT) + `pagead2.googlesyndication.com/ccm/collect`; `POST m.alza.cz/cdn-cgi/rum` (Cloudflare RUM); `POST m.alza.cz/metrics/td` | event payloads | ack | none | log writes | **Out of scope** (telemetry — documented candidate) | `live-verified` (documented) |

Web-family exposure note (2026-09-08 update): the top gap set from
`docs/gap-analysis.md` is now implemented — **G3**: `alza_web_pickup_places`
typed read tool covers W11–W14 (form + list + detail); **G1**:
`alza_web_place_order` + `alza_web_pay_after_order` typed tools (one-time tokens,
`web_place_order`/`web_after_order_payment` whitelist actions) expose the verified
O11/PA9 WCF pipeline; **G2**: the typed delivery/payment tools call v13 (v12
fallback). Remaining W-row candidate: W3/W4/W5 (HATEOAS cart, deferred as G4).
W16 (the Order2→3 trigger) resolved to `SaveOrder2`/`SaveAndConfirmOrder2` in the
2026-09-08 probe (O11). See `docs/gap-analysis.md` for the prioritization.

---

## Dynamic action registry (hypermedia, server-provided `AppAction.form`)

Actions the app resolves from server responses (`form.meta.href` + `meta.method` +
`meta.rel` + typed `form.values`; the executor injects `visitorId`/`userId`). Executed
in this MCP only via the typed tools above, never as a generic action endpoint.

| Action name(s) | Family | Typed exposure |
|---|---|---|
| `commodityDiscussionAction` | reviews | whitelist `discussion_posts` (static legacy path) |
| `writeReviewAction`, `ratingAction` | reviews | `alza_review_submit` |
| `activeWarrantyClaimsAction`, `showActiveWarrantyClaimsAction` | complaints | `alza_complaint_claims` |
| `uploadImageAction`, complaint attachment actions | attachments | `alza_upload_attachment` |
| `subscriptionAction`, `activateAction`, `updateInstallmentAction` | subscriptions | `alza_subscription_overview` / `_activate` / `_update_installment` |
| `limitExceededRepaymentAction` | subscriptions | `blocked` |
| `addressSearchAction`, `createAddressAction`, per-address `formUpdate`/delete | profile/address | `alza_address_search` / `_upsert` / `_delete` |
| `changePasswordAction`, `passwordAction`, `twoFactorAction`, `phoneNumberAction`, `gdprInfoAction`, `deleteAccountAction`, `deleteUserAccountAction` | account | `blocked` (credential-bearing / high-impact) |
| `searchOrdersAction`, `archiveOrdersAction`, `updateOrderDataAction`, `recalculationAction`, `cancelDropOrder`, `downloadAction` | orders | `blocked` (documented) |
| `v3/payment/getOrderDetailAction`, `paymentAction`, `KlarnaSession`, `GooglePayRequest`, `SubmitQuickOrder` | payments | `blocked` (external hand-offs / quick-order family) |
| `UnavailableBasketProductsAction`, `UnavailableBasketAccessoriesAction`, `CheckVouchersUnusedBalanceInBasketAction` (LeaveOrder1 response, 2026-09-08 probe) | web checkout (O11/W10) | `blocked` — server-provided follow-up actions on the LeaveOrder1 result (documented) |
| `bankIdAuthApiAction` (CheckOrder4 response), `GiveSharedLimitConsentAction` (SendOrder4 response), `PaymentAction` (WCF envelope field) | web checkout (O11) | `blocked` — server-driven hand-off actions (documented) |
| `alzaPlusActionBannerAction` (2026.17, `OrderInfo.alzaPlusActionBannerAction` + `AlzaPlusActionBanner` model) | delivery/payment response | `blocked` — server-driven banner action, new in 2026.17 (documented) |
| `afterSelectAction`, `afterDeselectAction` on `Delivery`/`Payment` items, incl. `paymentAfterSelectAction`/`paymentAfterDeselectAction` (2026.17) | delivery/payment selection | `blocked` — server-driven follow-up actions for select/deselect (documented; the static select path stays typed via `alza_select_pickup_point` + `sendOrder2`) |
| `addToCartAction`, `commodityCodesCarouselAction` (quick-order add) | basket | typed `alza_add_to_cart` covers the static code-based add; quick-order add `blocked` (dynamic) |
| `DeliveryVariantsActions`, `DeliveryTimeItemsWithForm`, `DeliveryHoursActions`, personal-delivery actions | delivery | `blocked` (dynamic forms) |

## Out of scope (documented, not exposed)

| Route / family | Reason |
|---|---|
| `/services/restservice.svc/v2/setDeviceToken` | device-token (push) — out of scope |
| `/api/log/v2/logs`, `api/log/v1/identity/audit` | telemetry / audit — out of scope |
| `/api/anonymous/v2/activities` | anonymous activity log — out of scope |
| `api/identity/v1/login/LoginUserAdmin` | administrative login — out of scope |
| `v1/clientKeys` (config) | app config, no user value | out of scope |
| `m.alza.cz/services/restservice.svc/v1/getCommodityLists` | web-host variant of the B10 route (same restservice family, observed in the 2026-09-08 web capture; the mobile B10 row + `commodity_lists` whitelist cover it — no separate exposure) |
| `chatAction`, `chatbot*` actions, `chatbotapi.alza.cz` (W18) | chat family is outside the 12 in-scope families (web capture 2026-09-08) |
| `logapi.alza.cz/api/log/v2/logs`, `m.alza.cz/metrics/*`, `cdn-cgi/rum` (W19) | web telemetry — out of scope (web capture 2026-09-08) |
| `next-api/auth/get-session` (W1) | Next.js framework session bootstrap — plumbing, documented |
| `newsAction`, `prescriptionPlacesAction` | roadmap / niche features outside the 12 families |
| PC builder, price watchlists, AlzaBox DOM scraping, hosted HTTP | explicitly excluded roadmap items |

## Corrections from deep APK audit

- Category uses `type` and `typeId` query parameters.
- Basket update uses `GET /services/restservice.svc/v2/updBasket/{basketId}/{flag}?isDelayedPayment=...`; no JSON body.
- `sendOrder1` is a GET cart/content step, not order submission by itself.
- No dedicated static complaint-submission route exists; complaint/claim flows are dynamic action-driven (re-verified in this audit: zero `complaint`/`reklamace` route constants in the APK).
- `POST /services/restservice.svc/v2/CreateUser` is source-confirmed; `Register` DTO = `{email, phone, pwd, code?}`; response parsed as `BaseResponseData`. Credential-bearing → typed tool with one-time token, not live-submitted in the E2E record.
- `user_review` route segments are boolean flags (`/api/users/{0|1}/commodities/{0|1}/review`), not user/commodity ids.
- `rateCommodityDiscussionPosts` is a GET with query params (`id`, rating form name), per the APK method constant.
- The discussion-post list has no static route in the APK; the app follows `commodityDiscussionAction` from the product detail. The legacy `getCommodityDiscussionPosts` path is exercised by the read journey.
- Checkout DTO shapes (verified against live `getDeliveryPaymentGroups`/`getDeliveryAssociations` responses and the APK `SelectedDelivery` wire class): `sendOrder2` takes `SelectedDeliveryPayment {deliveryGroups: SelectedDelivery[], paymentId, paymentCardId, selectedDeliveryOptionId, deliveryAddressId?, deliveryZipCode?, deliveryCity?, deliveryStreet?, deliveryName?}` with `SelectedDelivery {deliveryGroupId, deliveryId, deliveryServicesIds, parcelShopId, timeFrameId, timeSlotId}`. Top-level `selectedDeliveryOptionId` + `paymentId` alone (empty `deliveryGroups`) is accepted but leaves the delivery **unregistered** (`err:1` "Nebyl zvolen způsob dopravy a platby"), which then makes `orderfinished` fail. An AlzaBox pickup location is the `parcelShopId` (e.g. `1128203`, resolvable via `/api/personalPickup/v1/places/{deliveryOptionId}/{placeId}` behind the server-driven `deliveryOption`/`pickupPlaceForm` form); `deliveryId` stays the option id (e.g. `2680`).
- `sendOrder3` body is `{parameters: Parameters}`; the wire `Parameters` fields are the obfuscated `UserFieldKeys` names (`dEmail`, `oNote`, `iInfo`, `cBic`, `cIban`, `cIcDph`, `bankAccountOwnerName`, `newUserInfo`, `billingInfo`, `companyInfo`, `deliveryAddress`, `confirmPwd`, `eduId`). For guest orders the app sets `newUserInfo: {anonymOrder: true, login: <email>}` (the guest email goes into `newUserInfo.login`, not a top-level field).
- Observed live server-side gap (guest sessions, `sendOrder2` err:0 state): `POST .../v5/sendOrder3` returns HTTP 500 (empty user-info variants, all `Parameters` shapes) while with an unregistered delivery `orderfinished` 500s instead — so the full guest order+payment path is exercised on a real authenticated account (PKCE), matching the goal constraint.
- The live web checkout (www.alza.cz Order1/2/3.htm) runs on the **legacy WCF pipeline** `EShopService.svc`: `SaveOrder2` (delivery + payment registration; `alzaPlusSubscriptionId:0` + `cetelemLeasingId:0` skip the AlzaPlus/leasing gates) → `SaveOrder3` (user info: `registerUser`, `login`, `name`, `street`, `city`, `zip`, `phone`, `email`, …) → `SaveAndConfirmOrder2` (first attempt can return `ErrorLevel:113` + `alzaPlusPopupDialogAction` — the AlzaPlus promo gate; the web UI dismisses it with “Nemám zájem”, equivalent to an immediate retry → `ErrorLevel:0`) → `CheckOrder4` → `SendOrder4` (creates the order; response `GetOrderDetailAction` carries `order-details-{id}.htm?x={hash}`). `VerifyUser {input, isEmailVerification}` checks whether the e-mail has a registration. This is the pipeline the 2026-09-06 E2E record uses for real order creation (O11), because the mobile restservice `sendOrder3` 500s (see above). Web after-payment: `GetAfterPaymentDialog` (lists after-order methods: Apple Pay 213 / Kartou online 216 / Google Pay 219 / Platba 24 143 / MojePlatba 144 / Kryptoměnou 203) and `CreateAfterPayment` (initiates the selected gateway; MojePlatba redirects to `login.kb.cz` SSO). Order cancellation: `GET …/parts/{partId}/cancelForm` (PUT-form, `reason` 0–5 + `submit`) committed with `PUT …/parts/{partId}/cancellations {value:[…]}` → 202; hashless orders request the `?x=` link via `POST /api/anonymous/v1/orders/{id}/hashRequests`. All live-verified 2026-09-06 (see the complete E2E record).
- The mobile after-order-payment endpoints (`getafterorderpayments`, `afterOrderPayment`) resolve the order's *faktura* record for restservice-pipeline orders; for WCF-created orders they return `err:1` (“Faktura se zadaným ID neexistuje” / “Aktualizujte prosím aplikace”) across paymentIds, auth and UA variants tested — documented as the expected behaviour until a restservice-created order exists or the `sendOrder3` 500 is fixed server-side (see the complete E2E record).
- The `alza_Android` OAuth client is **confidential**, not public: `POST /connect/token` rejects requests lacking the client secret with HTTP 400 `invalid_client` (a public client would return `invalid_grant` for a bad code). The APK-embedded secret is recovered by porting the deobfuscated AES variant (20-byte key → Nk=5/Nr=11, table-driven equivalent-inverse-cipher core, CBC, zero IV) from `defpackage/f.java` + `defpackage/zlp.c`; both 2026.15 and 2026.17 embed the identical ciphertext/key, and the live token endpoint accepts the decoded 32-char secret (dummy code → `invalid_grant`). `scripts/alza-client-secret.mjs` reproduces the decode; the value is wired into both exchange scripts (overridable via `ALZA_CLIENT_SECRET`).

## APK 2026.16.1 / 2026.17 re-audit (2026-09-07)

Latest release at re-audit time: **2026.17.0** (Play Store, released 2026-09-03; release notes: bug fixes + “option to set a preferred application for bank payments”). APKs for 2026.15.0 / 2026.16.1 / 2026.17.0 were re-downloaded (APKCombo/PureApk CDN), decompiled (jadx 1.5.0), and diffed against the original 2026.15 audit:

- **Restservice route inventory is stable** (51 routes, identical across all three versions), with one version bump: `getDeliveryPaymentGroups` **v12 → v13 between 2026.16.1 and 2026.17.0** (both versions still served live in parallel — verified 2026-09-07; the typed tools still call v12; flipping them to v13 is a named gap in `docs/gap-analysis.md`).
- **New response-model fields (2026.17)**: `afterSelectAction` / `afterDeselectAction` (server-driven follow-up `AppAction`s on `Delivery` and `Payment` items of the D1 response), `Payment.isConditionalFreeDelivery`, `CardPayment.hideStoredPaymentCards`, payment data `canShowPaymentDetail`, `deliveryGroupIdsBeforeAction`. Response-side only — no input DTO changes.
- **New dynamic action names (2026.17)**: `alzaPlusActionBannerAction` (`OrderInfo`), plus the select/deselect action family above (all `blocked`/documented in the dynamic-action registry).
- **Bank-app payment (2026.17 feature)**: `PayViaBankAppResolver` deep-links the after-order payment into an installed bank app; 2026.17 adds the preferred-bank-app preference (`SetDefaultBankApp` analytics, `isBankAppOnboardingEnabled`) and `qrCodeResultReceiver`. API-level flow unchanged (PA2/PA3/PA9); documented as row PA11.
- **2026.16.1 intermediate**: `AccountUserInfo.detailedUserInfo` (response-side, already gone again in 2026.17) + `onProduct*Click` analytics events. No route changes.
- 2026.15/16/17 `AfterOrderRequestBody` is unchanged (`{cardId?, deviceFingerprint?, id, invoiceNumber, paymentId}`) — the MCP `alza_pay_after_order` DTO stays valid.
- The `cz.alza.base.api.*` module tree (catalog, order, contact, chat, device, proximity, serverconfig, …) is unchanged apart from a relocated cashback model — no new API modules/endpoints in 2026.17.

## Evidence status

- `source-confirmed`: routes listed in the APK inventory and targeted JADX reads.
- `live-verified`: OIDC discovery, catalog search, category facets/detail, product details, alternatives, discussion posts, basket/cart reads, delivery countries/branches/zips, order-add-info, anonymous order lookups, helpdesk questions, shopping lists (read journeys) **and the complete 2026-09-06 E2E order + real-payment record** (order 1056808137: real order created via the live web WCF chain, proforma + SPayD QR issued, MojePlatba after-payment executed to the KB gateway; O3/PA2/PA3/OR1/OR2/WCF1–WCF5/PA8–PA10/OR11/OR12 labeled accordingly).
- **Web checkout capture (2026-09-07/08, new-goal task 2):** Playwright live network
  capture of the `m.alza.cz` guest checkout (8 fresh visitor sessions) mapped the new
  HATEOAS REST family (checkout/cart, personalPickup/v1/*, Cookies/v1/groups, …),
  the web-hosted WCF services (`EShopService.svc/LeaveOrder1`, `restservice.svc/
  getOrderAddInfo` on the m.alza.cz host), and the 3-step page flow (Order4.htm is a
  live 404). Rows W1–W19 in section 13; record:
  `docs/live-evidence/web-checkout-mcz-2026-09-08.md` + digest
  `docs/live-evidence/web-checkout-mcz-digest.json`.
- **WCF operation probe (2026-09-08, new-goal task 3):** 92 candidate operation names
  POSTed in-browser to `www.alza.cz/Services/EShopService.svc/{op}`; exactly 10 return
  app-level 200 (the O11 pipeline + PA8/PA9 + `GetZipCodes`), the other 82 HTTP 404 —
  the WCF order+payment family is closed. `LeaveOrder2`/`LeaveOrder3` 404s resolve W16
  to `SaveOrder2`/`SaveAndConfirmOrder2` as the Order2→3 trigger. Record:
  `docs/live-evidence/wcf-operation-probe-2026-09-08.md` +
  `docs/live-evidence/wcf-operation-probe-2026-09-08.json`.
- The guest E2E probes (same endpoints, browser-backed transport) confirmed: `basket/add` → `getDeliveryPaymentGroups` → `sendOrder1` → `sendOrder2` (APK `SelectedDelivery` payload, err:0) all work; `sendOrder3` then 500s in the guest state (see Corrections).
- Transport note: Node/Undici and curl can receive Cloudflare challenge responses from the same WSL egress while a Python `requests.Session` follows the same-origin navigation redirect, retains in-memory cookies, and receives JSON. This is transport/client variance, not proof that extra spoofed headers are needed. The live Python comparison currently reaches navigation, params, and product-detail with HTTP 200; deliberately invalid category parameters return ordinary HTTP 400 JSON.
- The live Python journeys are read-only. Cart additions, coupon changes, list mutations, profile mutations, checkout, payment, and order submission are intentionally not exercised by the read-only scripts; the E2E record below is the only mutating live run.

## E2E order + payment record

**Complete record: `docs/live-evidence/e2e-order-payment-complete.md`**
(+ `e2e-order-payment-complete.json`), executed 2026-09-06 on a real authenticated
account (`e2e-user@example.invalid`, registered via `CreateUser`; user_id
100000001). Recorded: real order **1056808137** (104 CZK, AlzaBox 2680/1128203,
proforma payment 103) created through the live web WCF chain (O11: SaveOrder2 →
SaveOrder3 → SaveAndConfirmOrder2 (113 promo gate → retry → 0) → CheckOrder4 →
SendOrder4), proforma + SPayD QR issued, and a **real after-order payment executed**
(PA9: `CreateAfterPayment` paymentId 144 MojePlatba → KB MojePlatba SSO gateway).
Companion orders 1056806231 / 1056807586 were cancelled via OR11; 1056807179 remains
an unpaid proforma (auto-expires 2026-09-14).

**2026-09-08 addition (new-goal task 7):** real order **1057075103** (part
1057075103, book FKP0383232 35 CZK + AlzaBox, 104 CZK ex-VAT) created through
the exact `alza_web_place_order` WCF chain and after-paid via the
`alza_web_pay_after_order` `CreateAfterPayment` 144 MojePlatba hand-off
(`ErrorLevel:0` → `https://www.alza.cz/Secure/MojePlatba-aop.htm?aop=1325060564`).
Record: `docs/live-evidence/web-tool-e2e-2026-09-08.md` (+ `web-tool-e2e-2026-09-08.json`,
`web-tool-e2e-pay-2026-09-08.json`).

Earlier partial artifacts (kept for the audit trail): `e2e-order-payment.md` /
`e2e-order-payment.json` (pre-order read journey), `e2e-order-payment-partial-v1-pre-order.json`,
and `e2e-order-payment-partial-guest-sendorder3-500.json` (guest `sendOrder3` HTTP 500 —
the server-side gap that makes the WCF chain the recorded submission path; re-confirmed
2026-09-06 with the full authenticated `Parameters` shape).
