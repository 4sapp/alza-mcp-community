import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatPickupPoints } from "./format.js";
import type { RegisterableTool, ToolDeps } from "./types.js";

const inputSchema = {
  postal_code: z
    .string()
    .min(3)
    .describe(
      "Czech (or other supported country) postal code. Examples: '110 00', '11000', '602 00'. Spaces are tolerated."
    ),
  radius_km: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe("Search radius in kilometres. Default 15 km."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of pickup points to return. Default 10."),
  types: z
    .array(z.enum(["alzabox", "branch"]))
    .optional()
    .describe(
      "Restrict to specific pickup-point types. 'alzabox' = self-service AlzaBox parcel lockers (live list from Alza's public locker map, no cart needed). 'branch' = brick-and-mortar AlzaShop showrooms with staff. Default: both, merged and sorted by distance."
    ),
};

export function createFindPickupPointsTool(deps: ToolDeps): RegisterableTool {
  const name = "find_pickup_points";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Find AlzaBox lockers and Alza showrooms",
          description:
            "Find AlzaBox parcel lockers and AlzaShop showrooms near a Czech/Slovak postal code: name, address, GPS, distance and opening hours, sorted nearest first. " +
            "Use when the user asks where the nearest AlzaBox or Alza store is, or where they could pick up an order. No cart or login needed. " +
            "Lockers come from Alza's public locker map and are cached; each has a `parcelShopId`. Locker hours vary (many are nonstop, mall lockers follow mall hours) and are looked up for the first 10 lockers returned. " +
            "Important: a standalone locker list can't tell whether a given product fits. Alza excludes large items (observed: 34\"+ monitors) from the whole AlzaBox network and routes them to a few oversized-item pickup points. " +
            "To check a specific product, add it to the cart and read `delivery_options` (or `web_pickup_places`, which is cart-scoped). " +
            "Read-only. Example: `find_pickup_points({postal_code: '500 02', types: ['alzabox'], limit: 5})`",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["find_pickup_points"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const { points, warnings } = await deps.pickup.findPickupPoints({
              postalCode: args.postal_code,
              radiusKm: args.radius_km,
              limit: args.limit,
              types: args.types,
            });
            return {
              content: [{ type: "text", text: formatPickupPoints(points, warnings) }],
              structuredContent: warnings.length > 0 ? { points, warnings } : { points },
            };
          })
      );
    },
  };
}
