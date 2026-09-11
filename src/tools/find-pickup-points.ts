import { z } from "zod";
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
      "Restrict to specific pickup-point types. 'branch' = brick-and-mortar AlzaShop with staff (currently the only type that returns results). 'alzabox' = self-service parcel locker — accepted, but AlzaBox discovery is not yet implemented so it returns nothing. Default: both."
    ),
};

export function createFindPickupPointsTool(deps: ToolDeps): RegisterableTool {
  const name = "find_pickup_points";
  return {
    name,
    register(server, errorWrap) {
      server.registerTool(
        name,
        {
          title: "Find Alza showrooms",
          description:
            "Find Alza brick-and-mortar showrooms (AlzaShop) near a Czech/Slovak postal code: name, address, distance, and opening hours. " +
            "Use when the user wants to browse in person, get on-site advice, or find where an AlzaShop branch is. " +
            "Note: `types` accepts `alzabox`, but AlzaBox locker discovery is not yet implemented — only `branch` results are returned. For AlzaBox parcel shops in a checkout flow use `web_pickup_places` instead. " +
            "Read-only. Example: `find_pickup_points({postal_code: '110 00', radius_km: 10})`",
          inputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const points = await deps.pickup.findPickupPoints({
              postalCode: args.postal_code,
              radiusKm: args.radius_km,
              limit: args.limit,
              types: args.types,
            });
            return {
              content: [{ type: "text", text: formatPickupPoints(points) }],
              structuredContent: { points },
            };
          })
      );
    },
  };
}
