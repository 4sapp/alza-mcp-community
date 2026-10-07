import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { PcBuilder, DEFAULT_MAX_DETAIL_FETCHES, MAX_CHECK_PARTS, MAX_DETAIL_FETCHES, type BuildReport } from "../domain/pc-build-service.js";
import { PC_ROLES } from "../domain/pc-build.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const ROLE = z
  .enum(PC_ROLES)
  .describe("Component role. Optional — detected from the product's spec table when omitted; pass it if detection fails.");

const PART = z.object({
  code: z.string().min(1).describe("Alza product code from `search_products` / `get_product` (e.g. 'BD750m7b1'), not the numeric id."),
  role: ROLE.optional(),
});

const HEADROOM = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("PSU headroom over the estimated peak draw, as a fraction. Default 0.3 (30 %).");

const checkInput = {
  parts: z
    .array(PART)
    .min(1)
    .max(MAX_CHECK_PARTS)
    .describe(
      `The build's parts, 1–${MAX_CHECK_PARTS} Alza product codes (each costs one product-page load, cached 15 min). At most one cpu/motherboard/gpu/case/cooler/psu; ram and storage may repeat.`
    ),
  psu_headroom: HEADROOM,
};

const suggestInput = {
  budget: z
    .number()
    .int()
    .min(8000)
    .max(500000)
    .describe("Total budget in CZK for the parts suggested plus any fixed_parts. Example: 40000."),
  profile: z
    .enum(["gaming", "workstation", "office"])
    .optional()
    .describe("Budget split. gaming (default): GPU-heavy. workstation: CPU/RAM-heavy. office: no graphics card, CPU must have integrated graphics."),
  cpu_vendor: z
    .enum(["amd", "intel"])
    .optional()
    .describe("Restrict CPU candidates to one vendor (applied via the CPU category's real brand facet)."),
  fixed_parts: z
    .array(PART)
    .max(6)
    .optional()
    .describe("Parts the user already chose (Alza codes). They are kept, their cost is subtracted from the budget, and the rest is picked to be compatible with them."),
  skip_roles: z
    .array(z.enum(PC_ROLES))
    .optional()
    .describe("Roles to leave out (e.g. ['storage'] when reusing a drive, ['cooler'] for a boxed-cooler CPU)."),
  max_detail_fetches: z
    .number()
    .int()
    .min(1)
    .max(MAX_DETAIL_FETCHES)
    .optional()
    .describe(
      `Upper bound on product-detail page loads (each ~3–8 s). Default ${DEFAULT_MAX_DETAIL_FETCHES}, max ${MAX_DETAIL_FETCHES}. When exhausted, remaining roles are picked from listing cards without specs (their rules come back 'unknown').`
    ),
  psu_headroom: HEADROOM,
};

export function formatBuildReport(r: BuildReport, heading: string): string {
  const lines: string[] = [`## ${heading}`, ""];
  const head =
    r.budget !== undefined
      ? `**Overall: ${r.overall}** — total ${r.total} ${r.currency} of ${r.budget} budget${r.withinBudget ? "" : " (OVER BUDGET)"}`
      : `**Overall: ${r.overall}** — total ${r.total} ${r.currency}`;
  lines.push(head, "");
  lines.push("| role | part | price | stock |", "|---|---|---|---|");
  for (const p of r.parts) {
    const stock = p.inStock === true ? "in stock" : p.inStock === false ? "not purchasable now" : "unknown";
    lines.push(`| ${p.role}${p.origin === "fixed" ? " (fixed)" : ""} | [${p.name}](${p.url}) \`${p.code}\` | ${p.price ?? "?"} ${p.currency} | ${stock} |`);
  }
  lines.push("", "### Compatibility");
  for (const v of r.verdicts) {
    if (v.verdict === "not_applicable") continue;
    lines.push(`- **${v.verdict.toUpperCase()}** ${v.title}: ${v.detail}`);
  }
  const na = r.verdicts.filter((v) => v.verdict === "not_applicable").map((v) => v.rule);
  if (na.length) lines.push(`- not applicable: ${na.join(", ")}`);
  if (r.powerEstimate) {
    const e = r.powerEstimate;
    lines.push("", `Power: ~${e.totalW} W peak (CPU ${e.cpuW} + GPU ${e.gpuW} + platform ${e.platformW}); recommended PSU ≥ ${e.recommendedPsuW} W.`);
  }
  if (r.notes.length) lines.push("", "### Notes", ...r.notes.map((n) => `- ${n}`));
  lines.push("", `_${r.detailFetches} product page load(s)${r.categoryPages ? `, ${r.categoryPages} category page load(s)` : ""}. Prices and stock are live Alza values at fetch time._`);
  return lines.join("\n");
}

/** Plain-JSON copy for structuredContent (drops undefined keys). */
function toStructured(r: BuildReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
}

export function createPcBuildCheckTool(deps: ToolDeps): RegisterableTool {
  const name = "pc_build_check";
  const builder = new PcBuilder(deps.catalog);
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Check PC build compatibility",
          description:
            "Check whether a list of Alza PC parts works together. Fetches each part's spec table (one product-page load per part, roughly 5–20 s each when not cached; cached 15 min), detects its role (cpu, motherboard, ram, gpu, storage, case, cooler, psu) unless given, and runs every compatibility rule: CPU socket ↔ motherboard, RAM generation / DIMM type / slot count ↔ motherboard, RAM ↔ CPU memory controller, PSU wattage vs estimated peak draw + headroom, GPU length ↔ case, cooler height (air) or radiator size (liquid) ↔ case, cooler ↔ CPU socket, motherboard form factor ↔ case, PSU form factor ↔ case, and display output (GPU or iGPU). " +
            "Returns the parts list with live prices, total and stock, plus one verdict per rule (pass / warn / fail / unknown / not_applicable) with the exact spec values compared and the Czech spec row each came from, so you can explain the result. A spec Alza doesn't list gives 'unknown', never a silent pass. " +
            "Use after picking parts with `search_products`, or to re-check a `pc_build_suggest` result after swapping a part (pass each part's `role` from that result). Read-only.",
          inputSchema: checkInput,
          outputSchema: OUTPUT_SCHEMAS["pc_build_check"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const report = tagLinks(await builder.check({ parts: args.parts, psuHeadroom: args.psu_headroom }));
            return {
              content: [{ type: "text", text: formatBuildReport(report, "PC build check") }],
              structuredContent: toStructured(report),
            };
          })
      );
    },
  };
}

export function createPcBuildSuggestTool(deps: ToolDeps): RegisterableTool {
  const name = "pc_build_suggest";
  const builder = new PcBuilder(deps.catalog);
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Suggest a compatible PC build",
          description:
            "Propose a complete, compatibility-checked PC parts list from live Alza stock within a CZK budget. Splits the budget per component by profile (gaming / workstation / office), then picks parts in dependency order (CPU → motherboard → RAM → GPU → storage → case → cooler → PSU) from the real Alza component categories: one category listing page per role (in-stock cards only), a name pre-filter (chipset → socket, DDR type, PSU wattage), then product-detail fetches until a candidate passes the rules that apply given the parts already chosen. " +
            "Slow: about 8 listing pages plus up to `max_detail_fetches` product pages (default 14), roughly 1–3 minutes. Candidates are the top of Alza's own listing order, not the whole catalog. " +
            "Returns the same shape as `pc_build_check` (parts with prices/stock, total, per-rule verdicts with spec values) plus the budget allocation and notes on every skipped candidate. Pin parts the user already wants with `fixed_parts`. Re-check after any swap with `pc_build_check`. Read-only.",
          inputSchema: suggestInput,
          outputSchema: OUTPUT_SCHEMAS["pc_build_suggest"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const report = tagLinks(await builder.suggest({
              budget: args.budget,
              profile: args.profile,
              cpuVendor: args.cpu_vendor,
              fixedParts: args.fixed_parts,
              skipRoles: args.skip_roles,
              maxDetailFetches: args.max_detail_fetches,
              psuHeadroom: args.psu_headroom,
            }));
            return {
              content: [{ type: "text", text: formatBuildReport(report, `PC build suggestion (${report.profile ?? "gaming"}, ${args.budget} CZK)`) }],
              structuredContent: toStructured(report),
            };
          })
      );
    },
  };
}
