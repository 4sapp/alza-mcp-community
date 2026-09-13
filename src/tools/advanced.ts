import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import type { MobileAccount } from "../domain/mobile-account.js";
import type { RegisterableTool, ToolDeps, ToolResult } from "./types.js";
import { formatOrder, formatProfile, withConciseText } from "./account-format.js";

function apiAccount(deps: ToolDeps): MobileAccount {
  if (!deps.mobileAccount) throw new Error("mobile API account tools are not configured");
  return deps.mobileAccount;
}

function result(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

const jsonObject = z.record(z.string(), z.unknown());
const typedValues = z
  .array(
    z.object({
      name: z.string().min(1).max(64).describe("Form field name exactly as returned by the form response."),
      value: z.unknown().describe("Field value."),
      kind: z.enum(["text", "integer", "boolean", "decimal", "text-array", "integer-array"]).optional().describe("Field type from the form response, if provided."),
    }),
  )
  .max(20)
  .describe("Extra typed form values copied verbatim from the form response (payment/installment/consent fields). Omit if the form returned none.");
const appAction = jsonObject.describe(
  "An AppAction object copied verbatim from a prior tool response (e.g. `profile`); it must contain form.meta.href. Never hand-craft URLs.",
);
const confirmationToken = z
  .string()
  .min(32)
  .describe("One-time token from `prepare_mutation` prepared with the matching action.");
const AUTH_PREREQ =
  "Requires a loaded mobile API access token — check `account_status` first; if none is loaded, run `auth_start`, have the user complete the browser sign-in, then `auth_exchange` with the returned code and state.";

export function createAdvancedTools(deps: ToolDeps): RegisterableTool[] {
  const profile: RegisterableTool = {
    name: "profile",
    register(server, wrap) {
      server.registerTool(
        "profile",
        {
          title: "Read Alza user profile and address book",
          description:
            "Read the authenticated user's Alza profile: personal data, the delivery-address book with per-address HATEOAS actions (create/edit/delete/search), and account sections. " +
            "Use to inspect the account, to confirm the account binding (`user_id`, email), and to obtain the `action` objects required by `address_upsert`, `address_delete`, `address_search`, `complaint_claims`, and the subscription tools. " +
            AUTH_PREREQ +
            " Read-only. Honest caveat: with a stale or missing token the API may still answer HTTP 200 with an anonymous shape (`user_id: -1`, null email) — treat `user_id` as the binding signal, and refresh the token via `auth_start`/`auth_exchange` if it is -1.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["profile"],
        },
        async () => wrap("profile", async () => withConciseText(await apiAccount(deps).profile(), formatProfile)),
      );
    },
  };
  const contacts: RegisterableTool = {
    name: "contacts",
    register(server, wrap) {
      server.registerTool(
        "contacts",
        {
          title: "Read Alza account contacts",
          description:
            "Read the authenticated user's Alza contact list (mobile API v4/contacts endpoint). " +
            "Use to list or search the account's saved contacts, e.g. for complaint/claim context. " +
            "Do not use for the catalog category tree — that is `list_categories`. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["contacts"],
        },
        async () => wrap("contacts", async () => result(await apiAccount(deps).contacts())),
      );
    },
  };
  const register: RegisterableTool = {
    name: "register",
    register(server, wrap) {
      server.registerTool(
        "register",
        {
          title: "Register a new Alza account",
          description:
            "Register a new Alza account (mobile API CreateUser): submit email, phone, and password plus an optional verification code. " +
            "High-impact, credential-bearing side effect: creates a real Alza account the user will have to manage. " +
            "Use only with explicit user confirmation; requires a one-time token from `prepare_mutation` (action=`register`) passed as `confirmation_token`. " +
            "Do not use to sign in an existing account — that is the `auth_start`/`auth_exchange` flow.",
          inputSchema: {
            email: z.string().min(3).max(100).describe("Account email address (the login)."),
            phone: z.string().min(6).max(20).describe("Phone number, e.g. '+420 777 123 456'."),
            pwd: z.string().min(8).max(64).describe("Initial password. It is a credential — confirm with the user before sending."),
            code: z.string().max(32).optional().describe("Verification code, if Alza required one for this registration."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["register"],
        },
        async (args) => wrap("register", async () => result(await apiAccount(deps).register({ email: args.email, phone: args.phone, pwd: args.pwd, code: args.code }, args.confirmation_token))),
      );
    },
  };
  const addressUpsert: RegisterableTool = {
    name: "address_upsert",
    register(server, wrap) {
      server.registerTool(
        "address_upsert",
        {
          title: "Create or edit a delivery address",
          description:
            "Create or edit a delivery address on the Alza account by executing the server-provided address form action from `profile` (createAddressAction for create, the address's editAction for edit) with typed fields. " +
            "Use when the user wants to add a new shipping address or fix an existing one. " +
            "Mutating: requires a one-time token from `prepare_mutation` (action=`address_create` or `address_edit`); `kind=edit` additionally requires `address_id`. " +
            "Side effect: persists the address to the account's address book.",
          inputSchema: z
            .object({
              kind: z.enum(["create", "edit"]).describe("'create' for a new address, 'edit' to modify an existing one."),
              action: appAction,
              name: z.string().min(1).max(100).describe("Recipient name."),
              street: z.string().min(1).max(100).describe("Street and house number."),
              city: z.string().min(1).max(100).describe("City."),
              zip_code: z.string().min(3).max(10).describe("Postal code."),
              firm: z.string().max(100).optional().describe("Company name, for business addresses."),
              phone: z.string().min(6).max(20).optional().describe("Contact phone."),
              email: z.string().max(100).optional().describe("Contact email."),
              note: z.string().max(100).optional().describe("Delivery note for the courier."),
              address_type: z.enum(["HOME", "WORK", "OTHER"]).optional().describe("Address classification."),
              address_id: z.number().int().positive().optional().describe("Existing address id from `profile`. Required for kind=edit."),
              confirmation_token: confirmationToken,
            })
            .superRefine((v, ctx) => {
              if (v.kind === "edit" && v.address_id === undefined)
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "address_id is required when kind=edit", path: ["address_id"] });
            }),
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["address_upsert"],
        },
        async (args) => wrap("address_upsert", async () => result(await apiAccount(deps).addressUpsert(args.kind, args.action, { name: args.name, street: args.street, city: args.city, zip_code: args.zip_code, firm: args.firm, phone: args.phone, email: args.email, note: args.note, address_type: args.address_type, address_id: args.address_id }, args.confirmation_token))),
      );
    },
  };
  const addressDelete: RegisterableTool = {
    name: "address_delete",
    register(server, wrap) {
      server.registerTool(
        "address_delete",
        {
          title: "Delete a delivery address",
          description:
            "Delete a delivery address from the Alza account by executing the per-address delete action from the `profile` response. " +
            "Destructive: removes the address (id=`address_id`) from the account's address book. " +
            "Use only with explicit user confirmation, after showing which address will be deleted. " +
            "Requires a one-time token from `prepare_mutation` (action=`address_delete`).",
          inputSchema: {
            action: appAction,
            address_id: z.number().int().positive().describe("The address id to delete, from the `profile` address book."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["address_delete"],
        },
        async (args) => wrap("address_delete", async () => result(await apiAccount(deps).addressDelete(args.action, { address_id: args.address_id }, args.confirmation_token))),
      );
    },
  };
  const addressSearch: RegisterableTool = {
    name: "address_search",
    register(server, wrap) {
      server.registerTool(
        "address_search",
        {
          title: "Search delivery addresses",
          description:
            "Search the address database (zip/city) by following the server-provided addressSearchAction from the `profile` response. " +
            "Use to suggest a valid address before `address_upsert`, or to verify a zip/city combination. " +
            "Pass the `action` object verbatim from `profile` — never hand-craft it. " +
            "Read-only; no confirmation token required (but the profile action needs a loaded access token).",
          inputSchema: {
            action: appAction,
            query: z.string().min(1).max(50).describe("Zip or city query, e.g. '110 00' or 'Brno'."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["address_search"],
        },
        async (args) => wrap("address_search", async () => result(await apiAccount(deps).addressSearch(args.action, args.query))),
      );
    },
  };
  const paymentMethods: RegisterableTool = {
    name: "payment_methods",
    register(server, wrap) {
      server.registerTool(
        "payment_methods",
        {
          title: "List available payment methods",
          description:
            "List the payment-method groups available for the current Alza account cart (mobile API getDeliveryPaymentGroups payment projection). " +
            "Use after `delivery_options` and before order submission, to show the user payment choices and to obtain the `payment_id` needed by `web_place_order` (e.g. 103 proforma) or the mobile checkout. " +
            "Requires a non-empty cart. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            selected_delivery_option_id: z.number().int().positive().optional().describe("Delivery option id from `delivery_options` to list the payments valid for that delivery. Omit for the default set."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["payment_methods"],
        },
        async (args) => wrap("payment_methods", async () => result(await apiAccount(deps).paymentMethods(args.selected_delivery_option_id))),
      );
    },
  };
  const afterOrderPayments: RegisterableTool = {
    name: "after_order_payments",
    register(server, wrap) {
      server.registerTool(
        "after_order_payments",
        {
          title: "List after-order payment options",
          description:
            "List the after-order payment options for an unpaid order part (mobile API getafterorderpayments). " +
            "Use when the user has an unpaid order (see `order`) and wants to pay it through the mobile API; pass the returned payment id to `pay_after_order`. " +
            "Do not use for legacy web WCF orders — that path is `web_pay_after_order` (list ids via `mobile_read` operation=`web_after_payment_dialog`). " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The unpaid order id (from `order`)."),
            part_id: z.string().min(1).max(64).describe("The order part id to pay (from `order`)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["after_order_payments"],
        },
        async (args) => wrap("after_order_payments", async () => result(await apiAccount(deps).afterOrderPayments(args.order_id, args.part_id))),
      );
    },
  };
  const payAfterOrder: RegisterableTool = {
    name: "pay_after_order",
    register(server, wrap) {
      server.registerTool(
        "pay_after_order",
        {
          title: "Execute an after-order payment (mobile API)",
          description:
            "Execute an after-order payment on an unpaid mobile-API order (AfterOrderRequestBody: order id, invoice number, payment id from `after_order_payments`, optional stored-card id and device fingerprint). " +
            "High-impact, money movement: requires a one-time token from `prepare_mutation` (action=`after_order_payment`) and explicit user confirmation. " +
            "Do not use for legacy web WCF orders — that is `web_pay_after_order`. " +
            AUTH_PREREQ,
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The unpaid order id (from `order`)."),
            invoice_number: z.string().min(1).max(64).describe("Invoice number for the payment (from the order detail)."),
            payment_id: z.number().int().positive().describe("Payment method id from `after_order_payments`."),
            card_id: z.number().int().positive().optional().describe("Stored-card id to pay with, if the user has one on file."),
            device_fingerprint: z.string().max(128).optional().describe("Device fingerprint expected by the payment gateway, if known."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["pay_after_order"],
        },
        async (args) => wrap("pay_after_order", async () => result(await apiAccount(deps).payAfterOrder({ order_id: args.order_id, invoice_number: args.invoice_number, payment_id: args.payment_id, card_id: args.card_id, device_fingerprint: args.device_fingerprint }, args.confirmation_token))),
      );
    },
  };
  const order: RegisterableTool = {
    name: "order",
    register(server, wrap) {
      server.registerTool(
        "order",
        {
          title: "Read an Alza order",
          description:
            "Read an authenticated user's Alza order: lines, parts, milestones/tracking, and invoice document references; with `part_id`, the part detail as well. " +
            "Use to check order status, delivery tracking, or to collect the order/part ids needed by `after_order_payments`/`pay_after_order`. " +
            "`user_flag` 0/1 selects the order scope exactly as the mobile app does. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The order id to read."),
            part_id: z.string().min(1).max(64).optional().describe("Order part id for the part detail read. Omit for the whole order."),
            user_flag: z.union([z.literal(0), z.literal(1)]).default(0).describe("Order scope selector, 0/1, exactly as the mobile app sends it. Default 0."),
            initial_created: z.boolean().default(false).describe("Include the initial-creation view of the order. Default false."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["order"],
        },
        async (args) => wrap("order", async () => withConciseText(await apiAccount(deps).order(args.order_id, args.part_id, args.user_flag, args.initial_created), formatOrder)),
      );
    },
  };
  const reviewSubmit: RegisterableTool = {
    name: "review_submit",
    register(server, wrap) {
      server.registerTool(
        "review_submit",
        {
          title: "Submit a product review",
          description:
            "Submit a product review (1–5 rating plus optional text) by executing the server-provided review form action from the product detail (writeReviewAction/onSubmitReview or the rating form). " +
            "Use when the user wants to publish a review for a product they bought. " +
            "Mutating: the review becomes public on the product page — requires a one-time token from `prepare_mutation` (action=`review_submit`) and explicit user confirmation. " +
            "Optional `values` carries extra typed form fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            rating: z.number().int().min(1).max(5).describe("Star rating, 1 (worst) to 5 (best)."),
            text: z.string().max(10000).optional().describe("Review text, if the user wants to write one."),
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["review_submit"],
        },
        async (args) => wrap("review_submit", async () => result(await apiAccount(deps).reviewSubmit(args.action, { rating: args.rating, text: args.text, values: args.values }, args.confirmation_token))),
      );
    },
  };
  const complaintClaims: RegisterableTool = {
    name: "complaint_claims",
    register(server, wrap) {
      server.registerTool(
        "complaint_claims",
        {
          title: "List warranty claims",
          description:
            "List the account's active warranty claims by following the server-provided warranty-claims action (activeWarrantyClaimsAction / showActiveWarrantyClaimsAction) from authenticated navigation or order detail. " +
            "Use to show the user their open claims before filing or attaching evidence (see `upload_attachment`). " +
            "Pass the `action` object verbatim — never hand-craft it. Read-only.",
          inputSchema: {
            action: appAction,
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["complaint_claims"],
        },
        async (args) => wrap("complaint_claims", async () => result(await apiAccount(deps).complaintClaims(args.action))),
      );
    },
  };
  const subscriptionOverview: RegisterableTool = {
    name: "subscription_overview",
    register(server, wrap) {
      server.registerTool(
        "subscription_overview",
        {
          title: "Read AlzaSubscription overview",
          description:
            "Read the AlzaSubscription overview (phases, savings, trial settings) by following the server-provided subscriptionAction from the account menu or authenticated navigation. " +
            "Use to show the user their subscription state before `subscription_activate` or `subscription_update_installment`. " +
            "Pass the `action` object verbatim — never hand-craft it. Read-only.",
          inputSchema: {
            action: appAction,
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["subscription_overview"],
        },
        async (args) => wrap("subscription_overview", async () => result(await apiAccount(deps).subscriptionOverview(args.action))),
      );
    },
  };
  const subscriptionActivate: RegisterableTool = {
    name: "subscription_activate",
    register(server, wrap) {
      server.registerTool(
        "subscription_activate",
        {
          title: "Activate AlzaSubscription",
          description:
            "Activate AlzaSubscription by executing the server-provided activateAction form. " +
            "High-impact: starts a paid, recurring subscription — use only with explicit user confirmation after showing the terms from `subscription_overview`. " +
            "Requires a one-time token from `prepare_mutation` (action=`subscription_activate`). " +
            "Optional `values` carries the payment/installment fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["subscription_activate"],
        },
        async (args) => wrap("subscription_activate", async () => result(await apiAccount(deps).subscriptionActivate(args.action, { values: args.values }, args.confirmation_token))),
      );
    },
  };
  const subscriptionUpdateInstallment: RegisterableTool = {
    name: "subscription_update_installment",
    register(server, wrap) {
      server.registerTool(
        "subscription_update_installment",
        {
          title: "Update AlzaSubscription installment plan",
          description:
            "Change the AlzaSubscription installment plan by executing the server-provided updateInstallmentAction form. " +
            "High-impact: changes the payment schedule of a paid subscription — use only with explicit user confirmation. " +
            "Requires a one-time token from `prepare_mutation` (action=`subscription_update_installment`). " +
            "Optional `values` carries the installment fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["subscription_update_installment"],
        },
        async (args) => wrap("subscription_update_installment", async () => result(await apiAccount(deps).subscriptionUpdateInstallment(args.action, { values: args.values }, args.confirmation_token))),
      );
    },
  };
  const webPlaceOrder: RegisterableTool = {
    name: "web_place_order",
    register(server, wrap) {
      server.registerTool(
        "web_place_order",
        {
          title: "Place an order (legacy web WCF — working path)",
          description:
            "Place an order through the live-verified legacy web WCF checkout pipeline (EShopService.svc: SaveOrder2 → SaveOrder3 → SaveAndConfirmOrder2 with the documented AlzaPlus 113-gate retry → CheckOrder4 → SendOrder4). " +
            "This is the currently-working order-submission path — the mobile `place_order` (sendOrder3) returns HTTP 500 (docs/gap-analysis.md G1/G5). " +
            "Typed inputs only: `delivery_id`/`delivery_group_id` from `delivery_options`, `parcel_shop_id` from `web_pickup_places`, `payment_id` from `payment_methods`, plus the contact/address block. " +
            "High-impact, money-relevant: creates a real Alza order — use only with explicit user confirmation, with a one-time token from `prepare_mutation` (action=`web_place_order`). " +
            "Example: `web_place_order({delivery_id: 2680, parcel_shop_id: \"1128203\", payment_id: 103, name: \"Jan Novák\", street: \"Praha 110 00\", city: \"Praha\", zip_code: \"110 00\", phone: \"+420 777 123 456\", email: \"jan@example.cz\", confirmation_token: \"...\"})`.",
          inputSchema: {
            delivery_id: z.number().int().positive().describe("Delivery option id (e.g. 2680 for AlzaBox; from `delivery_options`)."),
            delivery_group_id: z.number().int().min(0).optional().describe("Live delivery group id (from `delivery_options`; omit or 0 for the server default)."),
            parcel_shop_id: z.string().max(32).optional().describe("Pickup place id (an AlzaBox parcelShopId from `web_pickup_places`), when delivering to a pickup point."),
            payment_id: z.number().int().positive().describe("Payment method id (e.g. 103 proforma; from `payment_methods`)."),
            name: z.string().min(1).max(100).describe("Recipient name."),
            street: z.string().min(1).max(100).describe("Street and house number."),
            city: z.string().min(1).max(100).describe("City."),
            zip_code: z.string().min(3).max(12).describe("Postal code."),
            phone: z.string().min(6).max(20).describe("Contact phone."),
            email: z.string().min(3).max(100).describe("Contact email (order confirmation goes here)."),
            register_user: z.boolean().default(false).describe("Register the buyer as a new account as part of checkout. Default false."),
            login: z.string().max(100).optional().describe("Existing login to buy as (defaults to the email)."),
            country_id: z.number().int().default(0).describe("Country id for the order. Default 0 (server default, CZ)."),
            quotation: z.boolean().default(false).describe("Treat the order as a quotation instead of a purchase. Default false."),
            internal_description: z.string().max(2000).optional().describe("Internal order note, if required."),
            user_consents: z.array(z.object({ consent_id: z.string().min(1).max(64), value: z.boolean() })).max(10).optional().describe("User consent flags verbatim from the checkout context (consent_id → accepted)."),
            basket_consents: z.array(z.object({ consent_id: z.string().min(1).max(64), value: z.boolean() })).max(10).optional().describe("Basket-level consent flags verbatim from the checkout context (consent_id → accepted)."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_place_order"],
        },
        async (args) => wrap("web_place_order", async () => result(await apiAccount(deps).webPlaceOrder({ delivery_id: args.delivery_id, delivery_group_id: args.delivery_group_id, parcel_shop_id: args.parcel_shop_id, payment_id: args.payment_id, name: args.name, street: args.street, city: args.city, zip_code: args.zip_code, phone: args.phone, email: args.email, register_user: args.register_user, login: args.login, country_id: args.country_id, quotation: args.quotation, internal_description: args.internal_description, user_consents: args.user_consents, basket_consents: args.basket_consents }, args.confirmation_token))),
      );
    },
  };
  const webPayAfterOrder: RegisterableTool = {
    name: "web_pay_after_order",
    register(server, wrap) {
      server.registerTool(
        "web_pay_after_order",
        {
          title: "Execute a web after-order payment (working path)",
          description:
            "Execute the after-order payment for an unpaid legacy-web order through the live-verified EShopService.svc CreateAfterPayment chain (the recorded real-payment path: e.g. MojePlatba 144 → KB SSO gateway). " +
            "Use when the user needs to pay a web-placed order that is still unpaid. " +
            "First list the available payment ids via `mobile_read` with operation=`web_after_payment_dialog` (GetAfterPaymentDialog). " +
            "High-impact, money movement: requires a one-time token from `prepare_mutation` (action=`web_after_order_payment`) and explicit user confirmation.",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The unpaid order id (from `order` or the order-detail link)."),
            payment_id: z.number().int().positive().describe("Payment method id from the after-payment dialog (e.g. 144 MojePlatba, 143 Platba 24, 103 proforma)."),
            order_hash: z.string().max(64).optional().describe("The `?x=` order hash from the order-detail link, if present."),
            invoice_id: z.string().max(32).optional().default("0").describe("Invoice id for the payment. Default \"0\" (server default)."),
            price: z.number().min(0).optional().describe("Override the amount to pay in CZK. Omit to pay the full due amount."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_pay_after_order"],
        },
        async (args) => wrap("web_pay_after_order", async () => result(await apiAccount(deps).webAfterOrderPayment({ order_id: args.order_id, payment_id: args.payment_id, order_hash: args.order_hash, invoice_id: args.invoice_id, price: args.price }, args.confirmation_token))),
      );
    },
  };
  const uploadAttachment: RegisterableTool = {
    name: "upload_attachment",
    register(server, wrap) {
      server.registerTool(
        "upload_attachment",
        {
          title: "Upload complaint/claim attachments",
          description:
            "Upload 1–5 image attachments (base64 data URLs, whitelisted image MIME types, max 10 MiB each) by executing the server-provided multipart action (uploadImageAction / complaint attachment actions) — typically for a warranty claim from `complaint_claims`. " +
            "Use when the user needs to attach photos (damage, label, invoice) to a claim or complaint. " +
            "Mutating: requires a one-time token from `prepare_mutation` (action=`attachment_upload`) and user confirmation. " +
            "Optional `values` carries extra typed form fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            files: z
              .array(
                z.object({
                  part_name: z.string().min(1).max(64).describe("Form part name from the form response."),
                  file_name: z.string().min(1).max(200).describe("Original file name, e.g. \"damage-1.jpg\"."),
                  mime_type: z.string().max(64).optional().describe("MIME type, e.g. \"image/jpeg\" (whitelisted image types only)."),
                  data_url: z.string().startsWith("data:").describe("Full base64 data URL, e.g. \"data:image/jpeg;base64,...\"."),
                }),
              )
              .min(1)
              .max(5)
              .describe("The image files to upload (1–5, ≤10 MiB each)."),
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["upload_attachment"],
        },
        async (args) => wrap("upload_attachment", async () => result(await apiAccount(deps).uploadAttachment(args.action, { files: args.files, values: args.values }, args.confirmation_token))),
      );
    },
  };
  return [profile, contacts, register, addressUpsert, addressDelete, addressSearch, paymentMethods, afterOrderPayments, payAfterOrder, webPayAfterOrder, order, reviewSubmit, complaintClaims, subscriptionOverview, subscriptionActivate, subscriptionUpdateInstallment, uploadAttachment, webPlaceOrder];
}
