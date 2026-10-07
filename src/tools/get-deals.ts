import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatPrice } from "./format.js";
import type { Deal } from "../domain/deals.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const inputSchema = {
  category_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Leaf category id to scan for discounts (from `list_categories`/`search_products`; top-level hub categories such as 'Počítače a notebooky' have no product grid and return nothing). Omit to scan the first page of a fixed set of popular categories (phones, notebooks, monitors, TVs, headphones)."
    ),
  min_discount_percent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Keep only products whose computed discount is at least this many percent. Default 0 (any discount)."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum deals to return, best discount first. Default 20, max 50."),
};

export function formatDeals(deals: Deal[], scanned: number): string {
  if (deals.length === 0) return `No discounted products found (scanned ${scanned} listing cards).`;
  const lines = deals.map(
    (d) =>
      `- **${d.name}** · code: \`${d.code}\` · ${formatPrice(d.price, d.currency)} (was ${formatPrice(d.originalPrice, d.currency)}, -${d.discountPercent} %)\n  ${d.url}`
  );
  return [`${deals.length} deal(s), best discount first (scanned ${scanned} listing cards):`, "", ...lines].join("\n");
}

export function createGetDealsTool(deps: ToolDeps): RegisterableTool {
  const name = "get_deals";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Find discounted Alza products",
          description:
            "Find currently discounted products on Alza.cz, with current price, original price, savings and a discount % COMPUTED from the observed prices (never from marketing badges). " +
            "Alza has no 'sale' facet or product-grid sale page, so this scans category listing pages (up to 3 pages ≈ 72 cards for a given `category_id`; page 1 of five popular categories when omitted) for cards showing a crossed-out original price or an 'Ušetříte' savings amount — it covers a bounded sample, not Alza's whole sale inventory (`candidatesScanned` says how many cards were checked). " +
            "Czech store only (alza.cz price-box wording); errors on other locales. Prices are the shelf price, not code/AlzaPlus+ coupon prices. Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["get_deals"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const res = tagLinks(await deps.catalog.getDeals({
              categoryId: args.category_id,
              minDiscountPercent: args.min_discount_percent,
              limit: args.limit,
            }));
            return {
              content: [{ type: "text", text: formatDeals(res.deals, res.candidatesScanned) }],
              structuredContent: {
                categoryIds: res.categoryIds,
                candidatesScanned: res.candidatesScanned,
                total: res.deals.length,
                deals: res.deals as unknown as Record<string, unknown>[],
              },
            };
          })
      );
    },
  };
}
