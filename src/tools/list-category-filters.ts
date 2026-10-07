import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatCategoryFilters } from "./format.js";
import type { RegisterableTool, ToolDeps } from "./types.js";

const inputSchema = {
  category_id: z
    .number()
    .int()
    .describe("Category id to read attribute filters for (from `list_categories` or `search_products`'s results)."),
};

export function createListCategoryFiltersTool(deps: ToolDeps): RegisterableTool {
  const name = "list_category_filters";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "List a category's filters",
          description:
            "List the brands and attribute filters (facets) Alza defines for a category, with real ids and product counts. " +
            "The attribute set differs per category (laptops have CPU/RAM facets, monitors have panel/resolution facets, …). " +
            "Pass `brands[].valueId` to `search_products` as `producer_ids` (brand filtering works in every category), and `filterable: true` groups' `param_id`/`value_id` pairs as `filters`. " +
            "Checkbox values are only honoured when Alza has an SEO landing page for that exact value (HDMI ports, for example); many others, notably panel type and resolution on monitors, are redirected to the unfiltered category (live 2026-10-07), and `filterable: true` does not predict which. When one isn't honoured, `search_products` returns an error rather than unfiltered results; drop that filter and compare candidates with `get_product`'s `params` instead. " +
            "Slider groups (`filterMode: \"range\"` — screen size, refresh rate, brightness, weight, port counts, …) filter by `{param_id, min?, max?}` in `search_products`'s `filters`, with min/max in the facet's own units as given by `values[].value` (e.g. millimetres for a monitor diagonal, inches for a TV diagonal; live-verified 2026-10-06). `filterable: false` groups are informational only. " +
            "Call this before using `producer_ids`/`filters` — never guess ids. Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["list_category_filters"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const filters = await deps.catalog.getCategoryFilters(args.category_id);
            return {
              content: [{ type: "text", text: formatCategoryFilters(filters) }],
              structuredContent: { category_id: filters.categoryId, brands: filters.brands, groups: filters.groups },
            };
          })
      );
    },
  };
}
