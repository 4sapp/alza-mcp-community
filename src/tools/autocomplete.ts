import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import type { AutocompleteResult } from "../domain/autocomplete.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const inputSchema = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("Partial or full search text, e.g. \"čistič kol\" or \"iphone\". Czech diacritics are fine."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Max entries per section (suggested phrases, categories, products, brands, articles). Default 5, max 10."),
};

export function formatAutocomplete(r: AutocompleteResult): string {
  const lines = [`Suggestions for "${r.query}":`];
  if (r.suggestions.length) lines.push("", "Phrases: " + r.suggestions.map((s) => `"${s}"`).join(", "));
  if (r.categories.length) lines.push("", "Categories:", ...r.categories.map((c) => `- ${c.name} (category_id ${c.id})`));
  if (r.brands.length) lines.push("", "Brands:", ...r.brands.map((b) => `- ${b.name} (producer ${b.id})`));
  if (r.products.length) lines.push("", "Products:", ...r.products.map((p) => `- ${p.name} (id ${p.id}${p.code ? `, code ${p.code}` : ""})`));
  if (r.articles.length) lines.push("", "Articles:", ...r.articles.map((a) => `- ${a.name}`));
  if (lines.length === 1) lines.push("", "No suggestions.");
  return lines.join("\n");
}

export function createAutocompleteTool(deps: ToolDeps): RegisterableTool {
  const name = "autocomplete";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Alza search suggestions",
          description:
            "Cheap search-box suggestions (plain HTTP, no page render): suggested query phrases plus matching categories, brands and products with ids/codes. Use it to refine a messy Czech query before a full `search_products` — pass a category `id` as `category_id`, or a product code to `get_product`.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["autocomplete"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const result = tagLinks(await deps.autocomplete.suggest(args.query, args.limit ?? 5));
            return {
              content: [{ type: "text", text: formatAutocomplete(result) }],
              structuredContent: { ...result },
            };
          })
      );
    },
  };
}
