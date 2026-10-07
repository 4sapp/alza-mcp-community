import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatProductLine } from "./format.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const inputSchema = {
  code: z
    .string()
    .min(1)
    .describe("Alza product code of the product to find alternatives for, e.g. 'RI054b5'. Same as the `code` from `search_products`."),
  mode: z
    .enum(["cheaper", "better-specs", "same-brand"])
    .optional()
    .describe(
      "Ranking mode. 'cheaper': strictly lower price than the source, cheapest first. 'same-brand': same brand as the source, best rating first then lower price. 'better-specs': rated at least as high as the source (unrated excluded), best rating first then lower price — a rating heuristic, NOT a spec-table comparison. Omit to get Alza's own alternatives order."
    ),
  limit: z.number().int().min(1).max(20).optional().describe("Maximum number of alternatives to return. Default 5, max 20."),
};

export function createRecommendAlternativesTool(deps: ToolDeps): RegisterableTool {
  const name = "recommend_alternatives";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Recommend alternative products",
          description:
            "Find alternatives to one product (\"something like this but cheaper / better / same brand\"). Candidate pool = Alza's own alternatives list for the product (mobile API, keyed by the numeric commodity id taken from the product URL); if that list is empty, or nothing in it survives the mode filter, falls back to a same-category `search_products` (`poolSource` says which was used). " +
            "Heuristics: `cheaper` = strictly lower price, cheapest first; `same-brand` = brand match (source brand vs. the candidate's name), then rating desc, price asc; `better-specs` = rating >= source rating (unrated dropped), then rating desc, price asc — it ranks by customer rating, it does not compare spec tables, so shortlist then compare with `get_product` `params`. The source product is always excluded. Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["recommend_alternatives"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const res = tagLinks(await deps.alternatives.recommend({ code: args.code, mode: args.mode, limit: args.limit }));
            const head = `Alternatives to **${res.source.name}**${res.mode ? ` (${res.mode})` : ""} — pool: ${res.poolSource}, ${res.candidatesConsidered} candidate(s) considered.`;
            const text =
              res.alternatives.length === 0
                ? `${head}\n\nNo alternatives matched.`
                : [head, "", ...res.alternatives.map(formatProductLine)].join("\n");
            return {
              content: [{ type: "text", text }],
              structuredContent: {
                source: res.source,
                mode: res.mode,
                poolSource: res.poolSource,
                candidatesConsidered: res.candidatesConsidered,
                alternatives: res.alternatives,
              },
            };
          })
      );
    },
  };
}
