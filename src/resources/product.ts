import type { Catalog } from "../domain/catalog.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { NotFoundError, truncateInput } from "../infra/errors.js";
import { tagLinks } from "../tools/tracking.js";

/** JSON-RPC code MCP assigns to "resource not found". */
export const RESOURCE_NOT_FOUND = -32002;

/**
 * MCP resource: alza://product/{code}
 * Returns the product as JSON. Browseable; agents can pull a product
 * without invoking a tool.
 */
export function createProductResource(catalog: Catalog) {
  return {
    name: "product",
    template: "alza://product/{code}",
    title: "Alza product by code",
    description: "Fetch full product details as JSON for a given Alza product code.",
    list: undefined,
    handler: async (uri: URL) => {
      // alza://product/WEXOA002B0  →  pathname is "/WEXOA002B0", host is "product"
      const code = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
      let found;
      try {
        found = await catalog.getProduct(code);
      } catch (err) {
        // -32002 is the MCP "resource not found" code (not an internal error).
        if (err instanceof NotFoundError) throw new McpError(RESOURCE_NOT_FOUND, err.message, { uri: truncateInput(uri.toString(), 120) });
        throw err;
      }
      const product = tagLinks(found);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(product, null, 2),
          },
        ],
      };
    },
  };
}
