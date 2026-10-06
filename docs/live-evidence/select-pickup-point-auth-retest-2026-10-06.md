# `select_pickup_point` re-test on an authenticated cart (2026-10-06)

Issue #23. Raw, redacted digest: `select-pickup-point-auth-retest-2026-10-06.json`. The
user id, basket id, delivery-group ids, the chosen AlzaBox `parcelShopId`, the email,
and the phone number are replaced with placeholders.

**Session**: authenticated owner session. The OAuth token was refreshed with the
refresh-token grant.
**Result**: still `unresolved` as a pickup-point selector. The authenticated session
behaves the same as the anonymous run on 2026-09-26.

## Cart safety

This is the repo owner's real account, so the test changed nothing on the cart.

- The cart was recorded first. It already held 3 lines (5 pieces), and both delivery
  groups were set to AlzaBox (delivery 2680) at the same parcel shop, with payment 103.
- **`add_to_cart` was intentionally not re-run.** The cart was already non-empty, which
  is the state `add_to_cart` would produce. The mobile API has no live-verified
  line-removal or quantity-decrease route (only `basket/add`, `updBasket` flags,
  `unlockbasket`, and the all-or-nothing `emptyCartAction`). An extra line therefore
  could not have been removed exactly, and the owner's existing cart had to stay as it
  was.
- The `select_pickup_point` payload mirrored the selection already on the cart (group 1
  → delivery 2680 → the same parcel shop). Even a call that persists state could not
  have changed anything.
- The cart was re-read afterwards. Lines, counts, deliveries, payment, and total were
  identical (`cart_unchanged: true`).

## Findings

1. `delivery_options` (v13 `getDeliveryPaymentGroups`, authenticated) returned 2 groups
   (59 + 56 deliveries) and 12 payments. Across all 127 entries, `beforeSelectAction`,
   `afterSelectAction`, and `afterDeselectAction` were all `null` (0 non-null). The
   AlzaBox entry (`id` 2680) has `associatedItems_cnt: 0` and no association form.
   Logging in does not make the server provide a pickup-point association form.
2. `select_pickup_point` → `POST v4/getDeliveryAssociations` with
   `{cardId: 0, deliveryGroups: [{deliveryGroupId, deliveryId: 2680, parcelShopId, …}]}`
   returned `err: 0` and `data[7]`: payment ids `103, 143, 144, 203, 243, 211, 216`,
   each with the delivery `price` under that payment (69/49 Kč), `paymentPrice`,
   `isLowCredit`, and `isHidden`. This is the same payment-association list the
   anonymous run returned on 2026-09-26. The route answers "which payments go with this
   delivery, and at what delivery fee". It does not select or list AlzaBox locations.

## Outcome applied (issue #23, "if it doesn't work" branch)

- The tool description now says what the route does (delivery → payment associations,
  no pickup-point selection). It points at the working chain: `add_to_cart` →
  `delivery_options` → `web_pickup_places` → `web_place_order` with `parcel_shop_id`.
- Proposal (not done in this change): rename the tool to `delivery_payment_associations`,
  or remove it. A rename changes the tool's public name and every registration/count
  file, so it is left to the maintainer to decide.
