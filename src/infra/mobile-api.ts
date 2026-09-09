import { randomBytes, createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppActionExecutor, type ExecuteAppActionOptions, type ServerAppAction } from "./app-action.js";

export interface MobileApiOptions {
  baseUrl?: string;
  visitorId?: string;
  userId?: number;
}

export interface OAuthStart {
  authorizationUrl: string;
  state: string;
}

interface OidcDiscovery {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export class MobileApi {
  readonly baseUrl: string;
  readonly visitorId: string;
  readonly userId?: number;
  private accessToken?: string;
  private refreshToken?: string;
  private pendingOAuth?: OAuthStart;
  private pendingCodeVerifier?: string;
  private oidc?: OidcDiscovery;

  get isAuthenticated(): boolean {
    return Boolean(this.accessToken);
  }

  constructor(opts: MobileApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.ALZA_API_BASE_URL ?? "https://www.alza.cz").replace(/\/$/, "");
    const stored = this.readStoredTokens();
    const explicitVisitor = opts.visitorId ?? process.env.ALZA_VISITOR_ID;
    this.visitorId = explicitVisitor ?? stored?.visitor_id ?? randomUUID();
    this.userId = opts.userId;
    if (stored?.access_token) this.accessToken = stored.access_token;
    if (stored?.refresh_token) this.refreshToken = stored.refresh_token;
  }

  /** Read an OAuth token stored by `scripts/alza-auth-login*` (ALZA_TOKEN_FILE, default ~/.alza-mcp/tokens.json).
   * Set ALZA_TOKEN_FILE=none to opt out. */
  private readStoredTokens(): { access_token?: string; refresh_token?: string; visitor_id?: string } | undefined {
    if (process.env.ALZA_TOKEN_FILE === "none") return undefined;
    const file = process.env.ALZA_TOKEN_FILE ?? join(homedir(), ".alza-mcp", "tokens.json");
    try {
      return JSON.parse(readFileSync(file, "utf8")) as { access_token?: string; refresh_token?: string; visitor_id?: string };
    } catch { return undefined; /* no readable token store — remain unauthenticated */ }
  }

  async discovery(): Promise<OidcDiscovery> {
    if (this.oidc) return this.oidc;
    const authority = process.env.ALZA_OAUTH_AUTHORITY ?? "https://identity.alza.cz";
    const response = await fetch(`${authority}/.well-known/openid-configuration`, { headers: { accept: "application/json", "user-agent": "Alza/2026.15.0 (Android)", "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8", "x-correlation-id": randomUUID(), "Balancer-Guid": this.visitorId } });
    if (!response.ok) throw new Error(`OAuth discovery failed with HTTP ${response.status}`);
    this.oidc = await response.json() as OidcDiscovery;
    return this.oidc;
  }

  async startOAuth(): Promise<OAuthStart> {
    const discovery = await this.discovery();
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      client_id: process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android",
      response_type: "code",
      scope: "email openid profile alza offline_access",
      redirect_uri: process.env.ALZA_OAUTH_REDIRECT_URI ?? "alza://identity",
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
      nonce: base64Url(randomBytes(32)),
      countryCode: process.env.ALZA_COUNTRY ?? "CZ",
      culture: process.env.ALZA_CULTURE ?? "cs-CZ",
    });
    const authorizationEndpoint = discovery.authorization_endpoint ?? "https://identity.alza.cz/connect/authorize";
    const out = { authorizationUrl: `${authorizationEndpoint}?${params}`, state };
    this.pendingOAuth = out;
    this.pendingCodeVerifier = verifier;
    return out;
  }

  /** The default `alza_Android` OAuth client is confidential: the token endpoint
   * rejects requests without the APK-embedded client secret (HTTP 400 invalid_client).
   * The default value is source-verified (decoded from the decompiled APK — see
   * scripts/alza-client-secret.mjs) and live-verified against /connect/token.
   * Set ALZA_OAUTH_CLIENT_SECRET to another value (or "" to omit it for public
   * clients) when using ALZA_OAUTH_CLIENT_ID with a different client. */
  private static clientSecret(): string | undefined {
    const v = process.env.ALZA_OAUTH_CLIENT_SECRET ?? "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";
    return v === "" ? undefined : v;
  }

  async exchangeOAuthCode(code: string, state: string): Promise<{ authenticated: true; expiresIn?: number }> {
    const pending = this.pendingOAuth;
    if (!pending || pending.state !== state) throw new Error("OAuth state is missing or does not match");
    const verifier = this.pendingCodeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing; start authentication again");
    const discovery = await this.discovery();
    const tokenEndpoint = discovery.token_endpoint ?? "https://identity.alza.cz/connect/token";
    const secret = MobileApi.clientSecret();
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android", code, redirect_uri: process.env.ALZA_OAUTH_REDIRECT_URI ?? "alza://identity", code_verifier: verifier, ...(secret ? { client_secret: secret } : {}) });
    const res = await fetch(tokenEndpoint, { method: "POST", headers: this.mobileHeaders({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }), body });
    if (!res.ok) throw new Error(`OAuth token exchange failed with HTTP ${res.status}`);
    const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("OAuth response did not contain an access token");
    this.accessToken = json.access_token;
    this.refreshToken = json.refresh_token;
    this.pendingOAuth = undefined;
    this.pendingCodeVerifier = undefined;
    return { authenticated: true, expiresIn: json.expires_in };
  }

  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false;
    const discovery = await this.discovery();
    const tokenEndpoint = discovery.token_endpoint ?? "https://identity.alza.cz/connect/token";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android",
      refresh_token: this.refreshToken,
      ...(MobileApi.clientSecret() ? { client_secret: MobileApi.clientSecret()! } : {}),
    });
    const res = await fetch(tokenEndpoint, { method: "POST", headers: this.mobileHeaders({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }), body });
    if (!res.ok) return false;
    const json = await res.json() as { access_token?: string; refresh_token?: string };
    if (!json.access_token) return false;
    this.accessToken = json.access_token;
    this.refreshToken = json.refresh_token ?? this.refreshToken;
    return true;
  }

  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = this.mobileHeaders(init.headers as unknown as Headers | Record<string, string> | Array<[string, string]>);
    // Absolute URLs (cross-host families like chatbotapi.alza.cz, row W18) bypass the base.
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
    let res = await fetch(url, { ...init, headers });
    if (res.status === 401 && this.refreshToken && await this.refreshAccessToken()) {
      res = await fetch(url, { ...init, headers: this.mobileHeaders(init.headers as unknown as Headers | Record<string, string> | Array<[string, string]>) });
    }
    const text = await res.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    if (!res.ok) throw new Error(`Alza API ${init.method ?? "GET"} ${path} failed with HTTP ${res.status}: ${summarize(value)}`);
    return value as T;
  }

  async executeAppAction(action: ServerAppAction, options: ExecuteAppActionOptions = {}): Promise<unknown> {
    const executor = new AppActionExecutor({ baseUrl: this.baseUrl, visitorId: this.visitorId, userId: this.userId, authorizationToken: this.accessToken });
    return executor.execute(action, options);
  }

  private mobileHeaders(input?: Headers | Record<string, string> | Array<[string, string]>): Headers {
    const headers = new Headers(input);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    headers.set("user-agent", headers.get("user-agent") ?? "Alza/2026.15.0 (Android)");
    headers.set("accept-language", headers.get("accept-language") ?? "cs-CZ,cs;q=0.9,en;q=0.8");
    headers.set("Balancer-Guid", this.visitorId);
    headers.set("x-correlation-id", headers.get("x-correlation-id") ?? randomUUID());
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);
    return headers;
  }

  async register(payload: { email: string; phone: string; pwd: string; code?: string }): Promise<unknown> {
    return this.request("/services/restservice.svc/v2/CreateUser", { method: "POST", body: JSON.stringify(payload) });
  }

  async afterOrderPayment(payload: { id: string; invoiceNumber: string; paymentId: number; cardId?: number; deviceFingerprint?: string }): Promise<unknown> {
    return this.request("/api/orders/v4/afterOrderPayment", { method: "POST", body: JSON.stringify(payload) });
  }

  async eanLookup(eans: string[]): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/getProductByEANlist", { method: "POST", body: JSON.stringify({ eanList: eans }) });
  }

  async search(searchTerm: string, page = 0): Promise<unknown> {
    return this.request("/services/restservice.svc/v5/search", { method: "POST", body: JSON.stringify({ searchTerm, id: 0, type: "PRODUCTION", typeId: 0, orderBy: 0, page, availabilityType: 0, selectedBranches: [], params: [], producers: [], sendPrices: false }) });
  }

  async category(id: number, type = "CATEGORY", typeId = 0): Promise<unknown> {
    // Live correction (2026-09-09): the server binds the query fields to T and P —
    // `type=`/`typeId=` return HTTP 400 ("The T field is required"/"The P field is required").
    return this.request(`/services/restservice.svc/v1/category/${id}?T=${encodeURIComponent(type)}&P=${encodeURIComponent(typeId)}`);
  }

  async facets(id: number, type = "CATEGORY", typeId = 0, search = ""): Promise<unknown> {
    return this.request(`/services/restservice.svc/v3/params/${id}?type=${encodeURIComponent(type)}&typeId=${typeId}&search=${encodeURIComponent(search)}`);
  }

  async product(id: number): Promise<unknown> {
    return this.request(`/api/legacy/catalog/v14/external/product/${id}`);
  }

  /** C5. Live correction (2026-09-09): Pgrik and Ucik are REQUIRED server-side
   * (HTTP 400 without them, even empty); take them from the router_product (C6)
   * response's self.href. */
  async legacyProduct(id: number, params: { pgrik?: string; ucik?: string; country?: string; electronicContentOnly?: boolean } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.pgrik) query.set("pgrik", params.pgrik);
    if (params.ucik) query.set("ucik", params.ucik);
    if (params.country) query.set("country", params.country);
    if (params.electronicContentOnly !== undefined) query.set("electronicContentOnly", String(params.electronicContentOnly));
    return this.request(`/api/legacy/catalog/v14/product/${id}${query.size ? `?${query}` : ""}`);
  }

  async routerProduct(id: number, params: { pgrik?: string; ucik?: string; country?: string; electronicContentOnly?: boolean } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.pgrik) query.set("pgrik", params.pgrik);
    if (params.ucik) query.set("ucik", params.ucik);
    if (params.country) query.set("country", params.country);
    if (params.electronicContentOnly !== undefined) query.set("electronicContentOnly", String(params.electronicContentOnly));
    return this.request(`/api/router/legacy/catalog/product/${id}${query.size ? `?${query}` : ""}`);
  }

  async alternatives(commodityId: number): Promise<unknown> {
    return this.request(`/services/restservice.svc/v1/alternatives/${commodityId}`);
  }

  async productsByEan(eans: string[]): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/getProductByEANlist", { method: "POST", body: JSON.stringify({ eanList: eans }) });
  }

  async hierarchicalFilter(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/hierarchicalFilter", { method: "POST", body: JSON.stringify(payload) });
  }

  async urlInfo(url: string): Promise<unknown> {
    return this.request("/api/catalog/v1/homePage/getUrlInfo", { method: "POST", body: JSON.stringify({ url }) });
  }

  async userNavigation(userId: string, eshopUrl?: string): Promise<unknown> {
    const query = eshopUrl ? `?eshopUrl=${encodeURIComponent(eshopUrl)}` : "";
    return this.request(`/api/users/${encodeURIComponent(userId)}/mainNavigation${query}`);
  }

  async catalogUserNavigation(): Promise<unknown> {
    return this.request("/api/catalog/v2/homePage/userNavigation");
  }

  async quickOrderSummary(userId: string, commodityId: number, params: { pgrik?: string; ucik?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.pgrik) query.set("pgrik", params.pgrik);
    if (params.ucik) query.set("ucik", params.ucik);
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/quickOrder/summary/commodities/${commodityId}${query.size ? `?${query}` : ""}`);
  }

  async userReview(userId: string, commodityId: number): Promise<unknown> {
    return this.request(`/api/users/${encodeURIComponent(userId)}/commodities/${commodityId}/review`);
  }

  async discussionPosts(commodityId: number, pageStart = 0, options: { parentId?: number; showOnlyWithoutAnswer?: boolean; orderBy?: number } = {}): Promise<unknown> {
    const query = new URLSearchParams({ id: String(commodityId), pageStart: String(pageStart), pageSize: "25" });
    if (options.parentId !== undefined) query.set("parentId", String(options.parentId));
    if (options.showOnlyWithoutAnswer !== undefined) query.set("showOnlyWithoutAnswer", String(options.showOnlyWithoutAnswer));
    if (options.orderBy !== undefined) query.set("orderBy", String(options.orderBy));
    return this.request(`/services/restservice.svc/v1/getCommodityDiscussionPosts?${query}`);
  }

  async submitDiscussionPost(payload: { commodityId: number; msg: string; userEmail: string; anonymous: boolean; notifications: boolean; parentPostId?: number }): Promise<unknown> { return this.request("/services/restservice.svc/v1/submitCommodityDiscussionPost", { method: "POST", body: JSON.stringify(payload) }); }
  async rateDiscussionPost(postId: number, rating: boolean): Promise<unknown> { return this.request(`/services/restservice.svc/v1/rateCommodityDiscussionPosts?id=${encodeURIComponent(postId)}&rating=${rating ? "true" : "false"}`); }

  async premiumTrial(userId: string): Promise<unknown> { return this.request(`/api/user/${encodeURIComponent(userId)}/v1/alzapremium/trial`); }
  async validateLoginName(email: string): Promise<unknown> { return this.request(`/services/restservice.svc/v1/validateLoginName?email=${encodeURIComponent(email)}`); }
  async o3Info(): Promise<unknown> { return this.request("/services/restservice.svc/v2/o3Info"); }
  async validateIsic(payload: { cardNumber: string; name: string }): Promise<unknown> { return this.request("/services/restservice.svc/v2/validateIsic", { method: "POST", body: JSON.stringify(payload) }); }
  async setCountry(payload: { countryId: number }): Promise<unknown> { return this.request("/services/restservice.svc/v1/setCountry", { method: "POST", body: JSON.stringify(payload) }); }
  async setIsic(payload: { isic: string }): Promise<unknown> { return this.request("/services/restservice.svc/v1/setIsic", { method: "POST", body: JSON.stringify(payload) }); }
  async addGift(payload: { rangeIdsGiftCodes: Array<{ priceRangeId: number; giftCodes: string[] }> }): Promise<unknown> { return this.request("/services/restservice.svc/v2/addGift", { method: "POST", body: JSON.stringify(payload) }); }
  async addOrderService(service: string, enabled: boolean, selected: boolean): Promise<unknown> { return this.request(`/services/restservice.svc/v1/addOrderService/${encodeURIComponent(service)}/${enabled ? 1 : 0}/${selected ? 1 : 0}`); }
  async setWatchdog(payload: { commodityId: number; email: string; isTrackingStock: boolean; price?: number }): Promise<unknown> { return this.request("/api/watchdog/v1", { method: "POST", body: JSON.stringify(payload) }); }
  async sendFeedback(payload: { text: string; email?: string; info: string }): Promise<unknown> { return this.request("/services/restservice.svc/v1/feedback", { method: "POST", body: JSON.stringify(payload) }); }

  async orderHelpdeskQuestions(): Promise<unknown> { return this.request("/api/orders/v1/helpdesk/questions"); }

  async visitorNavigation(): Promise<unknown> {
    return this.request(`/api/visitors/${encodeURIComponent(this.visitorId)}/mainNavigation`);
  }

  async branches(latitude: number, longitude: number): Promise<unknown> {
    const query = `?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`;
    return this.request(`/api/branches/v1/cityBranches${query}`);
  }

  async zipCodes(query?: string): Promise<unknown> {
    const params = new URLSearchParams({ deliveryId: "0" });
    if (query) params.set("search", query);
    return this.request(`/services/restservice.svc/v1/getZipCodes?${params}`);
  }

  async userData(): Promise<unknown> { return this.request("/services/restservice.svc/v2/getUserData"); }
  async contacts(): Promise<unknown> { return this.request("/services/restservice.svc/v4/contacts"); }

  async anonymousOrders(invoiceNumber: string): Promise<unknown> { return this.request(`/api/anonymous/v1/orders?invoiceNumber=${encodeURIComponent(invoiceNumber)}`); }
  async anonymousOrder(orderId: string): Promise<unknown> { return this.request(`/api/anonymous/v1/orders/${encodeURIComponent(orderId)}`); }
  async userOrder(userFlag: number, orderId: string, initialCreated = false): Promise<unknown> { return this.request(`/api/users/${userFlag}/v1/orders/${encodeURIComponent(orderId)}${initialCreated ? "?initialCreated=1" : ""}`); }
  async orderPart(orderId: string, partId: string): Promise<unknown> { return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/${encodeURIComponent(partId)}`); }
  async orderAddInfo(): Promise<unknown> { return this.request("/services/restservice.svc/v2/getOrderAddInfo?isGiftsEnabled=true"); }
  async order2Info(country = "CZ"): Promise<unknown> {
    // Live correction (2026-09-09): requestModel.Country is required (HTTP 400 without).
    return this.request(`/services/restservice.svc/v8/getOrder2Info?country=${encodeURIComponent(country)}`);
  }
  async afterOrderPayments(orderId: string, partId: string): Promise<unknown> { return this.request(`/services/restservice.svc/v2/getafterorderpayments/${encodeURIComponent(orderId)}/${encodeURIComponent(partId)}`); }
  async deliveryCountries(): Promise<unknown> { return this.request("/services/restservice.svc/v1/getAllDeliveryCountries"); }
  async costEstimate(payload: Record<string, unknown>): Promise<unknown> { return this.request("/api/orders/v1/costEstimate", { method: "POST", body: JSON.stringify(payload) }); }

  async paymentMethods(selectedDeliveryOptionId?: number): Promise<unknown> {
    const groups = await this.deliveryPaymentGroups(selectedDeliveryOptionId) as { payments?: unknown; paymentTip?: string; warnings?: string[] } | unknown[];
    if (groups && typeof groups === "object" && !Array.isArray(groups) && "payments" in (groups as Record<string, unknown>)) {
      const g = groups as { payments?: unknown; paymentTip?: string; warnings?: string[] };
      return { payments: g.payments ?? [], paymentTip: g.paymentTip ?? null, warnings: g.warnings ?? [] };
    }
    return { payments: groups ?? [], paymentTip: null, warnings: [] };
  }

  async commodityLists(type?: number): Promise<unknown> { return this.request(`/services/restservice.svc/v1/getCommodityLists${type === undefined ? "" : `?type=${encodeURIComponent(type)}`}`); }
  async commodityList(listId: number): Promise<unknown> { return this.request(`/services/restservice.svc/v1/getCommodityLists/${listId}`); }
  async createCommodityList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v1/createCommodityList", { method: "POST", body: JSON.stringify(payload) }); }
  async renameCommodityList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v1/renameCommodityList", { method: "POST", body: JSON.stringify(payload) }); }
  async deleteCommodityList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v1/deleteCommodityList", { method: "POST", body: JSON.stringify(payload) }); }
  async addCommodityToList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v2/addCommodityToList", { method: "POST", body: JSON.stringify(payload) }); }
  async deleteCommodityFromList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v2/deleteCommodityFromList", { method: "POST", body: JSON.stringify(payload) }); }
  async moveCommodityToList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v2/moveCommodityToList", { method: "POST", body: JSON.stringify(payload) }); }

  async updateBasket(basketId: number, flag: boolean, isDelayedPayment = false): Promise<unknown> {
    return this.request(`/services/restservice.svc/v2/updBasket/${encodeURIComponent(basketId)}/${flag ? 1 : 0}?isDelayedPayment=${isDelayedPayment ? "true" : "false"}`);
  }
  async unlockBasket(country = "CZ"): Promise<unknown> {
    // Live correction (2026-09-09): GET (POST → 405) and requestModel.Country is required.
    return this.request(`/services/restservice.svc/v1/unlockbasket?country=${encodeURIComponent(country)}`);
  }
  async addCoupon(coupon: string): Promise<unknown> { return this.request(`/services/restservice.svc/v1/addcoupon/${encodeURIComponent(coupon)}`); }
  async deleteCoupon(coupon: string): Promise<unknown> { return this.request(`/services/restservice.svc/v1/delcoupon/${encodeURIComponent(coupon)}`); }


  async cart(): Promise<unknown> { return this.request("/services/restservice.svc/v10/gridOrder1"); }

  async cartInfo(): Promise<unknown> {
    return this.request("/services/restservice.svc/v3/basketInfo");
  }

  async addByCode(code: string, amount = 1): Promise<unknown> {
    return this.request("/services/restservice.svc/v2/basket/add", { method: "POST", body: JSON.stringify({ code, amount }) });
  }

  async deliveryPaymentGroups(selectedDeliveryOptionId?: number): Promise<unknown> {
    const query = selectedDeliveryOptionId === undefined ? "" : `?selectedDeliveryOptionId=${selectedDeliveryOptionId}`;
    // App 2026.17 calls v13; v12 is served in parallel (both versions
    // live-verified 2026-09-07 and 2026-09-08). Use v13 and fall back to v12
    // only if the server stops serving that version.
    try {
      return await this.request(`/services/restservice.svc/v13/getDeliveryPaymentGroups${query}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("/v13/getDeliveryPaymentGroups") && msg.includes("HTTP 404")) {
        return await this.request(`/services/restservice.svc/v12/getDeliveryPaymentGroups${query}`);
      }
      throw err;
    }
  }

  /** Web pickup family (m.alza.cz checkout; live-mapped 2026-09-08, rows W11–W14). */
  async webPickupPlaceForm(params: { orderId?: number; groupId?: number; latitude?: number; longitude?: number }): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.orderId !== undefined) q.set("orderId", String(params.orderId));
    if (params.groupId !== undefined) q.set("groupId", String(params.groupId));
    if (params.latitude !== undefined) q.set("latitude", String(params.latitude));
    if (params.longitude !== undefined) q.set("longitude", String(params.longitude));
    const qs = q.toString();
    return this.request(`/api/personalPickup/v1/pickupPlaceForm${qs ? `?${qs}` : ""}`);
  }

  async webPickupPlaces(params: { types?: number[]; latitude?: number; longitude?: number; orderId?: number; groupId?: number; limit?: number; offset?: number }): Promise<unknown> {
    const q = new URLSearchParams();
    for (const [i, t] of (params.types ?? []).entries()) q.set(`types[${i}]`, String(t));
    if (params.latitude !== undefined) q.set("latitude", String(params.latitude));
    if (params.longitude !== undefined) q.set("longitude", String(params.longitude));
    if (params.orderId !== undefined) q.set("orderId", String(params.orderId));
    if (params.groupId !== undefined) q.set("groupId", String(params.groupId));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.offset !== undefined) q.set("offset", String(params.offset));
    const qs = q.toString();
    return this.request(`/api/personalPickup/v1/places${qs ? `?${qs}` : ""}`);
  }

  /** Web HATEOAS cart family (m.alza.cz checkout; W3–W5, gap-analysis G4).
   * The basket is visitor-keyed: the add works with the Balancer-Guid header
   * alone (live-verified cookie-less 2026-09-09) and its response carries the
   * `order/{basketId}/item/{itemId}` link that yields the basket id. */
  async webAddToCart(commodityId: number, count: number): Promise<unknown> {
    return this.request("/api/basket/v1/items", { method: "POST", body: JSON.stringify({ items: [{ commodityId, count }] }) });
  }

  async webCart(basketId: number): Promise<{ cart: unknown; items: unknown }> {
    const cart = await this.request(`/api/v1/visitors/${this.visitorId}/baskets/${basketId}/checkout/cart?country=CZ`);
    const items = await this.request(`/api/v1/anonymous/baskets/${basketId}/checkout/cart/items?country=CZ`);
    return { cart, items };
  }

  /** Home category carousel (C12): the full route is server-provided in the
   * C11 navigation response (`appLink catalogLocalTitlePage`); the `pgri`/`ui`
   * params are required (the bare route returns HTTP 400). */
  async homeCategories(categoryId: number, pgri?: string, ui?: string): Promise<unknown> {
    const q = new URLSearchParams();
    if (pgri !== undefined) q.set("pgri", pgri);
    if (ui !== undefined) q.set("ui", ui);
    const qs = q.toString();
    return this.request(`/api/catalog/v1/homePage/categories/${categoryId}${qs ? `?${qs}` : ""}`);
  }

  /** Chatbot family (chatbotapi.alza.cz, row W18 — live shapes 2026-09-09).
   * Navigation needs a `country` query field (HTTP 400 without); the chat POST
   * needs `ListCategoryId` in the body (an empty array works without product
   * context) and returns `{configuration {configId, teamName, welcomeText,
   * sessionExist, messages…}, showChat}`. */
  async chatNavigation(country = "CZ"): Promise<unknown> {
    return this.request(`https://chatbotapi.alza.cz/api/visitors/${this.visitorId}/v1/navigation?country=${encodeURIComponent(country)}`);
  }

  async chatSend(payload: { country: string; pageType: number; forceInitialize: boolean; initialInput: string | null; referrer: string | null; listCategoryId: unknown[]; commodityType?: number; commodityCode?: string | null; manufacturer?: string | null; entityId?: string | null; seoPrefix?: string | null }): Promise<unknown> {
    return this.request(`https://chatbotapi.alza.cz/api/visitors/${this.visitorId}/v1/chat?country=${encodeURIComponent(payload.country)}`, { method: "POST", body: JSON.stringify(payload) });
  }

  /** WCF GetZipCodes twin (D5 twin, live-verified 2026-09-09): the body field is
   * `Search` (PascalCase); the response Value is an HTML snippet of `zip-item`
   * divs (data-id/data-city/data-text); ErrorLevel 14 when nothing matches. */
  async webZipCodes(search: string): Promise<unknown> {
    return this.webWcfStep("GetZipCodes", { Search: search });
  }

  async webPickupPlaceDetail(placeId: number, orderId?: number, groupId?: number): Promise<unknown> {
    const q = new URLSearchParams();
    if (orderId !== undefined) q.set("orderId", String(orderId));
    if (groupId !== undefined) q.set("groupId", String(groupId));
    const qs = q.toString();
    return this.request(`/api/personalPickup/v1/places/${placeId}${qs ? `?${qs}` : ""}`);
  }

  /** Legacy web WCF checkout pipeline (O11): EShopService.svc JSON operations.
   * Responses arrive WCF-wrapped as {"d":{...}}; the unwrapped step result
   * (with `ErrorLevel`, `Message`, `GetOrderDetailAction`, …) is returned. */
  async webWcfStep(op: string, body: unknown): Promise<Record<string, unknown>> {
    const res = (await this.request<Record<string, unknown>>(`/Services/EShopService.svc/${op}`, { method: "POST", body: JSON.stringify(body) })) ?? {};
    if ("d" in res && res.d !== null && typeof res.d === "object") return res.d as Record<string, unknown>;
    return res;
  }

  async deliveryAssociations(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v4/getDeliveryAssociations", { method: "POST", body: JSON.stringify(payload) });
  }

  async sendOrder1(): Promise<unknown> {
    return this.request("/services/restservice.svc/v4/sendOrder1");
  }

  async sendOrder2(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v7/sendOrder2", { method: "POST", body: JSON.stringify(payload) });
  }

  async sendOrder3(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v5/sendOrder3", { method: "POST", body: JSON.stringify(payload) });
  }

  async approveOrder4(): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/approveOrder4");
  }

  async finishOrder(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/api/orders/v7/orderfinished", { method: "POST", body: JSON.stringify(payload) });
  }
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 300);
  try { return JSON.stringify(value).slice(0, 500); } catch { return "unserializable response"; }
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
