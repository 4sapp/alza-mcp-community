import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import type { MobileAccount } from "../domain/mobile-account.js";
import type { WatchdogEntry } from "../domain/watchdog.js";
import type { RegisterableTool, ToolDeps, ToolResult } from "./types.js";

/**
 * Typed wrapper over Alza's native price/stock watchdog (issue #17, rows
 * B9, B9a, B9b). Alza stores the watchdog and emails the account's login address —
 * the MCP keeps no state. Writes are guarded by `prepare_mutation` tokens.
 */

function apiAccount(deps: ToolDeps): MobileAccount {
  if (!deps.mobileAccount) throw new Error("mobile API account tools are not configured");
  return deps.mobileAccount;
}

function result(value: Record<string, unknown>, text: string): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: value };
}

const AUTH_PREREQ =
  "Requires a loaded mobile API access token — check `account_status` first; if none is loaded, run `auth_start`, have the user complete the browser sign-in, then `auth_exchange` with the returned code and state.";
const userId = z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response).");
const commodityId = z.number().int().positive().describe("Alza product (commodity) id — the numeric `id` from `search_products`/`get_product`, e.g. 12999617.");
const confirmationToken = z.string().min(32).describe("One-time token from `prepare_mutation` prepared with the matching action.");

function formatList(items: WatchdogEntry[], emptyMessage: string | null): string {
  if (items.length === 0) return emptyMessage ? `No watchdogs set (${emptyMessage}).` : "No watchdogs set.";
  return [
    `${items.length} watchdog(s):`,
    ...items.map((w) => {
      const conditions = [w.is_tracking_stock ? "back in stock" : null, w.max_price !== null ? `price below ${w.max_price} Kč` : null].filter(Boolean).join(" or ");
      return `- ${w.name ?? `commodity ${w.commodity_id}`} (id ${w.commodity_id}, now ${w.current_price ?? "?"} Kč, ${w.availability ?? "availability unknown"}) — notify when ${conditions || "?"}; watchdog_id ${w.watchdog_id}`;
    }),
  ].join("\n");
}

export function createWatchdogTools(deps: ToolDeps): RegisterableTool[] {
  const list: RegisterableTool = {
    name: "watchdog_list",
    register(server, wrap) {
      return server.registerTool(
        "watchdog_list",
        {
          title: "List price/stock watchdogs",
          description:
            "List the price/stock watchdogs set on the user's Alza account. Alza calls the feature \"Hlídací pes\" (row B9a). Each entry has `watchdog_id`, `commodity_id`, name, current price, availability, `is_tracking_stock`, and `max_price` (the alert fires when the price drops below this; null means price is not watched). " +
            "Use it to answer \"what am I watching?\", to find the `watchdog_id` for `watchdog_delete`, or to check before `watchdog_set`, which refuses a product that already has a watchdog. " +
            "Pass `user_id`, the numeric Alza user id from `profile`. " + AUTH_PREREQ + " Read-only. The account email is not included in the output.",
          inputSchema: {
            user_id: userId,
            limit: z.number().int().min(1).max(100).optional().describe("Page size. Omit for Alza's default (20)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["watchdog_list"],
        },
        async (args) => wrap("watchdog_list", async () => {
          const out = await apiAccount(deps).watchdogList(args.user_id, args.limit);
          return result(out, formatList(out.items, out.empty_message));
        }),
      );
    },
  };
  const set: RegisterableTool = {
    name: "watchdog_set",
    register(server, wrap) {
      return server.registerTool(
        "watchdog_set",
        {
          title: "Set a price/stock watchdog",
          description:
            "Create an Alza watchdog for one product (row B9). Alza emails the account's login address when the product is back in stock (`track_stock`) and/or when its price drops below `max_price` (CZK incl. VAT, must be below the current price). Alza stores and runs the watchdog, so nothing is kept on the MCP side. " +
            "Use for requests like \"tell me when this drops under 5000 Kč\" or \"let me know when it's back in stock\". " +
            "If the product already has a watchdog, this call refuses. To change the conditions, delete it with `watchdog_delete` first and then set it again. " +
            "Persistent account write: confirm with the user, then get a one-time token from `prepare_mutation` (action=`watchdog_set`). " + AUTH_PREREQ +
            " Example: `watchdog_set({user_id: \"100000001\", commodity_id: 12999617, max_price: 15, track_stock: false, confirmation_token})`.",
          inputSchema: {
            user_id: userId,
            commodity_id: commodityId,
            max_price: z.number().positive().optional().describe("Notify when the price drops below this amount (CZK incl. VAT). It must be below the current price. Omit to watch only stock."),
            track_stock: z.boolean().default(true).describe("Notify when the product becomes available. Default true. Set it to false to watch only the price (then `max_price` is required)."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["watchdog_set"],
        },
        async (args) => wrap("watchdog_set", async () => {
          const out = await apiAccount(deps).watchdogSet({ user_id: args.user_id, commodity_id: args.commodity_id, max_price: args.max_price, track_stock: args.track_stock }, args.confirmation_token);
          return result(out, `Watchdog set on commodity ${out.commodity_id} (watchdog_id ${out.watchdog_id}). ${out.notification as string}`);
        }),
      );
    },
  };
  const del: RegisterableTool = {
    name: "watchdog_delete",
    register(server, wrap) {
      return server.registerTool(
        "watchdog_delete",
        {
          title: "Delete a price/stock watchdog",
          description:
            "Delete one Alza watchdog (row B9b). Pass `watchdog_id` (from `watchdog_list`), or pass `commodity_id` and the tool looks up the watchdog on that product through Alza's own delete action. " +
            "Use when the user no longer wants alerts for a product, or before `watchdog_set` to change an existing watchdog's conditions. " +
            "Account write: confirm with the user, then get a one-time token from `prepare_mutation` (action=`watchdog_delete`). " + AUTH_PREREQ,
          inputSchema: {
            user_id: userId,
            watchdog_id: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional().describe("Watchdog UUID from `watchdog_list`. Provide this or `commodity_id`."),
            commodity_id: commodityId.optional().describe("Product id whose watchdog should be removed. Used when `watchdog_id` is omitted."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["watchdog_delete"],
        },
        async (args) => wrap("watchdog_delete", async () => {
          if (args.watchdog_id === undefined && args.commodity_id === undefined) throw new Error("pass watchdog_id (from watchdog_list) or commodity_id");
          const out = await apiAccount(deps).watchdogDelete({ user_id: args.user_id, watchdog_id: args.watchdog_id, commodity_id: args.commodity_id }, args.confirmation_token);
          return result(out, `Watchdog ${out.watchdog_id as string} deleted.`);
        }),
      );
    },
  };
  return [list, set, del];
}
