import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { Catalog } from "./domain/catalog.js";
import { MobileAccount } from "./domain/mobile-account.js";
import { Pickup } from "./domain/pickup.js";
import { Alternatives } from "./domain/alternatives.js";
import { Reviews } from "./domain/reviews.js";
import { AlzaBrowser } from "./infra/browser.js";
import { NotFoundError, UpstreamError } from "./infra/errors.js";
import { log } from "./infra/logger.js";
import { findProductPrompt } from "./prompts/find-product.js";
import { createProductResource } from "./resources/product.js";
import { createFindPickupPointsTool } from "./tools/find-pickup-points.js";
import { createGetProductTool } from "./tools/get-product.js";
import { createCompareProductsTool } from "./tools/compare-products.js";
import { createGetProductReviewsTool } from "./tools/get-product-reviews.js";
import { createAutocompleteTool } from "./tools/autocomplete.js";
import { Autocomplete } from "./domain/autocomplete.js";
import { createRecommendAlternativesTool } from "./tools/recommend-alternatives.js";
import { createListCategoriesTool } from "./tools/list-categories.js";
import { createGetDealsTool } from "./tools/get-deals.js";
import { createListCategoryFiltersTool } from "./tools/list-category-filters.js";
import { createSearchProductsTool } from "./tools/search-products.js";
import { createAccountTools } from "./tools/account.js";
import { createAdvancedTools } from "./tools/advanced.js";
import { createPcBuildCheckTool, createPcBuildSuggestTool } from "./tools/pc-builder.js";
import { createWatchdogTools } from "./tools/watchdog.js";
import { registerToolsets, type LockedToolsets } from "./tools/toolsets.js";
import { MobileApi } from "./infra/mobile-api.js";
import { ImpersonateTransport, cfFetch } from "./infra/impersonate-transport.js";
import type { ToolResult } from "./tools/types.js";

const VERSION = "0.4.0";

export interface BuildOptions {
  baseUrl?: string;
  cdpUrl?: string;
  /** Reuse an existing browser instead of creating one (HTTP catalog-only mode
   * shares one across sessions). A shared browser is NOT closed by `close()`. */
  browser?: AlzaBrowser;
  /** Reuse an existing Chrome-fingerprint sidecar (same ownership rule as `browser`). */
  cfTransport?: ImpersonateTransport;
  /** Toolsets this deployment refuses to enable, with the reason (see toolsets.ts). */
  lockedToolsets?: LockedToolsets;
  /** Auto-load ALZA_TOKEN_FILE (default true; see MobileApiOptions.loadTokenFile). */
  loadTokenFile?: boolean;
  /** Extra sentence appended to the server instructions (e.g. the HTTP-mode note). */
  instructionsNote?: string;
}

export interface BuildResult {
  server: McpServer;
  /** Call on shutdown to release the browser. */
  close: () => Promise<void>;
}

export function buildServer(opts: BuildOptions = {}): BuildResult {
  const browser = opts.browser ?? new AlzaBrowser({ baseUrl: opts.baseUrl, cdpUrl: opts.cdpUrl });
  const catalog = new Catalog(browser);
  // Chrome-fingerprint sidecar (curl_cffi) — tried FIRST for the account stack:
  // it bypasses the Cloudflare bot wall without a browser (verified 2026-09-15).
  // Optional by design: no interpreter with curl_cffi → the transport is dead
  // and the existing chain (plain fetch → browser fallback) applies unchanged.
  const cfTransport = opts.cfTransport ?? new ImpersonateTransport();
  // The browser transport backs the catalog AND the account stack's bot-challenge fallback
  // (same-origin /services/restservice.svc routes are JS-challenge-gated for plain fetch).
  const mobileApi = new MobileApi({
    baseUrl: opts.baseUrl,
    browser,
    httpFetch: cfTransport.available ? cfFetch(cfTransport) : undefined,
    fetchImpl: cfTransport.available ? cfFetch(cfTransport) : undefined,
    loadTokenFile: opts.loadTokenFile,
  });
  const mobileAccount = new MobileAccount(mobileApi);
  // AlzaBox lockers come from the public salesNetwork API, which sits behind the
  // Cloudflare bot wall: reuse MobileApi's sidecar → fetch → browser chain.
  const pickup = new Pickup(browser.locale, { getJson: (url) => mobileApi.request(url) });
  const autocomplete = new Autocomplete(mobileApi);
  const reviews = new Reviews(browser, catalog, mobileApi);
  const alternatives = new Alternatives(catalog, mobileApi);
  const deps = { catalog, reviews, pickup, mobileAccount, alternatives, autocomplete };

  const server = new McpServer(
    { name: "alza-mcp", title: "Alza (unofficial)", version: VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "Alza.cz catalog and shopping assistant. Unofficial — not affiliated with or endorsed by Alza.cz a.s. " +
        "Tools are grouped into toolsets and only `catalog` + `auth` are enabled by default to keep the visible tool list small — call `list_toolsets` to see every group, then `set_toolset({id, enabled: true})` to turn on the one a task needs (e.g. `basket_and_checkout` before placing an order) before calling its tools. " +
        "Catalog (always on): `autocomplete` (search-box suggestions to refine a query) → `search_products` (keyword + filters) → `get_product` (detail) → `get_product_reviews` (reviews); `compare_products` (2–6 codes side by side); `recommend_alternatives` for cheaper / better-rated / same-brand alternatives to a product; `get_deals` for discounted products; `list_categories` for category ids; `find_pickup_points` for AlzaBox lockers and AlzaShop showrooms near a postal code. " +
        "Account & checkout (enable `basket_and_checkout`; OAuth token auto-loads from ~/.alza-mcp/tokens.json; check `account_status`): `cart`, `add_to_cart`, `delivery_options`, `select_pickup_point`, `checkout_preview` → `place_order` (mobile API), or the legacy web WCF path `web_add_to_cart` → `web_cart` → `web_pickup_places` → `web_place_order`. " +
        "Order submission currently works via the legacy web WCF path (`web_place_order`); the mobile `place_order` (sendOrder3) returns HTTP 500 (docs/gap-analysis.md G1/G5). Cancel with `cancel_order`. " +
        "Credentials are never collected by the MCP. High-impact mutations (payment, registration, address, review, subscription, attachment, order) require a one-time token from `prepare_mutation` (in the always-on `auth` toolset) — confirm with the user before calling them. " +
        "PC building (enable `pc_builder`): `pc_build_suggest` proposes a compatibility-checked parts list within a CZK budget; `pc_build_check` checks any parts list (socket, RAM, PSU wattage, GPU/cooler clearance, form factor). " +
        "`mobile_read` (toolset `advanced_raw`) is the raw read-only escape hatch for mobile API operations without a dedicated tool." +
        (opts.instructionsNote ? ` ${opts.instructionsNote}` : ""),
    }
  );

  const errorWrap = async (name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      const message = friendlyError(err);
      log.warn(`tool ${name} error`, { error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };

  registerToolsets(server, errorWrap, [
    createSearchProductsTool(deps),
    createGetProductTool(deps),
    createCompareProductsTool(deps),
    createGetProductReviewsTool(deps),
    createRecommendAlternativesTool(deps),
    createFindPickupPointsTool(deps),
    createListCategoryFiltersTool(deps),
    createListCategoriesTool(deps),
    createGetDealsTool(deps),
    createAutocompleteTool(deps),
    ...createAccountTools(deps),
    ...createAdvancedTools(deps),
    ...createWatchdogTools(deps),
    createPcBuildCheckTool(deps),
    createPcBuildSuggestTool(deps),
  ], opts.lockedToolsets);

  const productResource = createProductResource(catalog);
  server.registerResource(
    productResource.name,
    new ResourceTemplate(productResource.template, { list: undefined }),
    {
      title: productResource.title,
      description: productResource.description,
      mimeType: "application/json",
    },
    productResource.handler
  );

  server.registerPrompt(
    findProductPrompt.name,
    findProductPrompt.config,
    findProductPrompt.handler
  );

  return {
    server,
    close: async () => {
      if (!opts.cfTransport) cfTransport.close();
      if (!opts.browser) await browser.close();
    },
  };
}

function friendlyError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof UpstreamError) {
    return `Alza upstream error (HTTP ${err.status}). ${err.message}`;
  }
  if (err instanceof ZodError) {
    const issues = err.issues
      .slice(0, 5)
      .map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`)
      .join("; ");
    return `Invalid arguments — ${issues}`;
  }
  if (err instanceof Error) {
    if (err.message.includes("Timeout") || err.message.includes("timeout")) {
      return "Alza took too long to respond. The site may be slow right now — please retry.";
    }
    if (err.message.includes("net::") || err.message.includes("ERR_")) {
      return `Network error talking to Alza: ${err.message}`;
    }
    return `Error: ${err.message}`;
  }
  return "Unknown error";
}
