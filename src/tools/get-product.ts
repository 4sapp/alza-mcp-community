import { z } from "zod";
import { formatProduct } from "./format.js";
import type { RegisterableTool, ToolDeps } from "./types.js";

const inputSchema = {
  code: z
    .string()
    .min(1)
    .describe(
      "Alza product code, e.g. 'WEXOA002B0'. This is the canonical identifier returned by `search_products` (the `code` field). Not the numeric id."
    ),
};

export function createGetProductTool(deps: ToolDeps): RegisterableTool {
  const name = "get_product";
  return {
    name,
    register(server, errorWrap) {
      server.registerTool(
        name,
        {
          title: "Get product details",
          description:
            "Fetch details for a single product by its Alza code (the `code` from `search_products`, e.g. 'WEXOA002B0' — not the numeric id): name, price (with the original price when discounted), availability, rating, brand, category, primary image, URL, and the scraped spec table when the product page carries one (up to 30 spec rows). " +
            "Use after `search_products` to compare shortlisted candidates in depth, and to get the canonical URL to show the user. " +
            "For reviews use `get_product_reviews`; for the complete spec sheet (parameterGroups) use `mobile_read` with operation=`router_product` and product_id = the numeric `d########` id from the product URL. " +
            "Sourced from the product page's JSON-LD schema, so values are accurate and stable. Read-only.",
          inputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const product = await deps.catalog.getProduct(args.code);
            return {
              content: [{ type: "text", text: formatProduct(product) }],
              structuredContent: { product: product as unknown as Record<string, unknown> },
            };
          })
      );
    },
  };
}
