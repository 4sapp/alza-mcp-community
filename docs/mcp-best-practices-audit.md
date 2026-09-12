# MCP best-practices audit — alza-mcp

Date: 2026-09-10. Scope: all 41 tools + product resource + find-product prompt + server
instructions, audited against the MCP specification and Anthropic's tool-design guidance.
Every finding is cited to a source; priorities P0 (fix first) → P3 (nice-to-have).

## Sources

| # | Guidance | URL |
|---|---|---|
| S1 | MCP spec (2025-06-18) — Tools: tool definition (name/title/description/inputSchema/outputSchema/annotations), structured content, output schema, error handling (protocol vs tool-execution errors), security (validate inputs) | https://modelcontextprotocol.io/specification/2025-06-18/server/tools |
| S2 | MCP spec (draft, fetched 2026-09-10) — Tool names (1–128 chars, allowed charset, unique per server; clients MAY prefix with server identifier for disambiguation), no-param schema recommendation, stateful-tool guidance (retention in descriptions, expiry errors), deterministic ordering for prompt caching | https://modelcontextprotocol.io/specification/draft/server/tools |
| S3 | MCP docs (2026-07-28) — Client best practices: progressive tool discovery relies on "descriptive tool names and descriptions"; "The real fix is for server authors to provide `outputSchema`" | https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices |
| S4 | Anthropic — "Writing effective tools for AI agents" (2025-09-11): design tools for agents; few thoughtful tools over endpoint wrappers; overlapping/vague tools confuse agents; meaningful namespacing by service/resource; high-signal responses, avoid low-level identifiers (uuid, mime_type); pagination/filtering/truncation with sensible defaults; `response_format` concise/detailed pattern; unambiguous parameter names (`user_id` not `user`); helpful actionable error messages; "prompt-engineering your tool descriptions and specs" is one of the most effective methods | https://www.anthropic.com/engineering/writing-tools-for-agents |
| S5 | Anthropic — "Define tools" (Claude platform docs): "Provide extremely detailed descriptions. This is by far the most important factor in tool performance" — what it does, when to use it **and when it shouldn't**, what each parameter means, caveats; aim for 3–4+ sentences; consolidate related operations into fewer tools; meaningful namespacing (e.g. `github_list_prs`); design responses to return only high-signal information; `input_examples` for complex tools | https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools |

## Inventory (41 tools)

Legend — Description: **A** = agent-facing (when-to-use/when-not, outcome) · **M** =
endpoint-mechanics phrasing ("Read X endpoint / POST a Y payload") · **S** = stale
(v0.1/v0.2 caveats that no longer match the implementation). Params: **d** = described,
**u** = undocumented. Annotations: R=readOnly, D=destructive, I=idempotent, O=openWorld.
Output: **md** = markdown text + structured · **raw** = raw upstream JSON (unbounded).

### Catalog (`src/tools/`)

| Tool | Desc | Params | Annotations | Output |
|---|---|---|---|---|
| `search_products` | A (exemplary: use-cases, follow-up guidance) | d (all) | R I O | md |
| `get_product` | A + **S** ("params … often empty in v0.1 — planned for v0.2") — impl scrapes `paramTbl` rows (catalog.ts:86,182) | d | R I | md |
| `get_product_reviews` | A + **S** ("v0.1 returns aggregate values only … `reviews` array will be empty") — impl scrapes individual reviews (reviews.ts:30-106) | d | R I | md |
| `find_pickup_points` | A + **S** ("AlzaBox … planned for v0.2") while schema advertises `types: ["alzabox","branch"]` but only `branch` returns data (pickup.ts:39 "AlzaBox lockers — v0.2") | d | R I O | md |
| `list_categories` | A (drill-down guidance) | d | R I | md |

### Account — auth, cart, checkout (`src/tools/account.ts`)

| Tool | Desc | Params | Annotations | Output |
|---|---|---|---|---|
| `alza_auth_discovery` | A-ish (read-only, no credentials) | — (no params) | R I | raw |
| `alza_auth_start` | A (3-step flow stated) | — | ~R I | raw |
| `alza_auth_exchange` | A (what to pass / never pass) | **u** (code, state) | ~R I | raw |
| `alza_mobile_read` | M + catch-all: 41-value operation enum + free-form `args` record | **u** (operation, args) | R I | raw |
| `alza_prepare_mutation` | **A+** (action→executor mapping, DTO examples) — exemplar | **u** (action enum values) | R, ~I | raw |
| `alza_mutate_list` | **A+** (per-action payload DTOs with dated ModelState evidence) — exemplar | **u** (action, token, payload) | ~R ~I | raw |
| `alza_account_status` | M-ish, thin | — | R I | raw |
| `alza_cart` | M ("Read basketInfo and gridOrder1") | — | R I | raw (≈20 KB) |
| `alza_add_to_cart` | M ("POST a BuyByCode-compatible payload") | **u** (code, quantity) | ~R ~I | raw |
| `alza_delivery_options` | M ("Call … getDeliveryPaymentGroups endpoint") | **u** | R I | raw |
| `alza_select_pickup_point` | M ("POST … DeliveryPaymentAssociation payload") | **u** (association) | ~R ~I | raw |
| `alza_checkout_preview` | M, but states non-submission + token | **u** | R ~I | raw |
| `alza_place_order` | M, but states prerequisites + token | **u** (4 payloads) | ~R ~I | raw |
| `alza_web_pickup_places` | **A+** (fields returned, read-only, follow-up tool) | d (partial) | R I | raw |
| `alza_web_add_to_cart` | **A+** (visitor-keyed basket, follow-up, mutating note) | d | ~R ~I | raw |
| `alza_web_cart` | A-ish (HATEOAS cart state + item fields listed, cross-ref to `alza_web_add_to_cart`, read-only) | d | R I | raw |
| `alza_chat_navigation` | A-ish (row W18, read-only) | d | R I | raw |
| `alza_chat_send` | A-ish (page_type codes with dated capture) | d (partial) | ~R ~I | raw |

### Account — profile, orders, payments, subscriptions (`src/tools/advanced.ts`)

| Tool | Desc | Params | Annotations | Output |
|---|---|---|---|---|
| `alza_profile` | A-ish (what's returned; auth prerequisite) | — | R I | raw (large) |
| `alza_contacts` | M-ish, thin | — | R I | raw |
| `alza_register` | **A+** (credential-bearing, token + confirmation) | **u** (email/phone/pwd/code) | ~R ~I | raw |
| `alza_address_upsert` | A-ish (action source + token); typed fields | **u** (most) | ~R ~I | raw |
| `alza_address_delete` | M-ish + token | **u** | ~R ~I | raw |
| `alza_address_search` | M-ish (read-only stated) | **u** | R I | raw |
| `alza_payment_methods` | A-ish (prerequisite: cart with products) | **u** | R I | raw |
| `alza_after_order_payments` | A-ish (follow-up tool named) | **u** | R I | raw |
| `alza_pay_after_order` | **A+** (money movement, token + confirmation) | **u** (most) | ~R ~I | raw |
| `alza_order` | A-ish (scope params explained in desc) | **u** (4) | R I | raw |
| `alza_review_submit` | A-ish (action source + token) | **u** (action, values) | ~R ~I | raw |
| `alza_complaint_claims` | M-ish | **u** | R I | raw |
| `alza_subscription_overview` | A-ish | **u** | R I | raw |
| `alza_subscription_activate` | A-ish (high-impact + token) | **u** | ~R ~I | raw |
| `alza_subscription_update_installment` | A-ish (high-impact + token) | **u** | ~R ~I | raw |
| `alza_upload_attachment` | **A+** (1–5 files, MIME, size limits, token) | **u** (action, files, values) | ~R ~I | raw |
| `alza_web_place_order` | **A+** (working path vs G1/G5, sources of each id, token) | d (all) | ~R ~I | raw |
| `alza_web_pay_after_order` | **A+** (recorded payment path, token) | d (most) | ~R ~I | raw |

### Prompt + resource

| Item | State |
|---|---|
| `find-product` prompt | Good guided workflow; references catalog tool names (must follow rename map) |
| `alza://product/{code}` resource | Good (JSON product); description fine |

### Server instructions (src/server.ts:52-62)

Present and useful (workflow + token rules); references old tool names; does not state
which order-submission path is currently working (web WCF chain per G1/G5).

## Findings

### F-01 · P0 · Naming convention split (36 tools)
5 catalog tools are bare (`search_products` …), 36 account tools carry an `alza_`
server-name prefix → the pi gateway surfaces `alza_search_products` vs
`alza_alza_cart` (double prefix). S2: names only need uniqueness *within a server*;
clients "MAY … prefix tool names with a server identifier" for disambiguation — so the
server-side `alza_` prefix is redundant and produces doubled names. S5: meaningful
namespacing is by *service/resource* (`github_list_prs`), not by server name.
**Fix:** drop the `alza_` prefix from all 36 tools (bare names, one convention).
Rename map in §Rename map. Update every cross-reference: server instructions, the
find-product prompt, resource description, and all description-level tool references.

### F-02 · P0 · Descriptions: endpoint-plumbing phrasing + stale caveats
36/41 tools are described as HTTP plumbing ("Read basketInfo and gridOrder1",
"POST a BuyByCode-compatible payload") without when-to-use / when-NOT-to-use, and none
of the catalog-era "v0.1/v0.2" caveats survive: `get_product` params are now scraped
(catalog.ts:86,182), `get_product_reviews` returns individual reviews (reviews.ts:30-106),
`find_pickup_points` still can't return AlzaBox (pickup.ts:39). S5: "extremely detailed
descriptions … by far the most important factor" — what it does, when to use it and when
not, each parameter's effect, caveats, 3–4+ sentences. S4: descriptions are loaded into
agent context and steer tool selection; small refinements yield dramatic improvements.
**Fix:** rewrite every tool description agent-facing (outcome → when to use → when not →
prerequisites → side effects → example where useful); remove stale v0.1/v0.2 lines.

### F-03 · P1 · Undocumented parameters
~25 parameters across account/advanced tools have no `.describe()` (e.g.
`auth_exchange.code/state`, `add_to_cart.code`, `select_pickup_point.association`,
`place_order` payloads, `mobile_read.operation/args`, `order.*`, `register.*`).
S5: "what each parameter means and how it affects the tool's behavior"; S4: unambiguous,
self-explanatory names (we're compliant on names: `user_id`-style).
**Fix:** describe every parameter (source of the value, format, example where useful).

### F-04 · P1 · Catch-all `alza_mobile_read`
41-operation enum + free-form `args: record` with a one-line description; overlaps typed
tools (`basket_info`↔`cart`, `user_data`↔`profile`, `contacts`↔`contacts`,
`search`↔`search_products`, `category`↔`list_categories`). S4: "tools that overlap in
function or have a vague purpose … agents can get confused"; each tool needs "a clear,
distinct purpose". **Fix:** reposition explicitly as the raw-API escape hatch:
description states "prefer the typed tool when one exists (list)", documents the
highest-value operations with args examples (router_product/legacy_product need
`product_id` = the `d########` from the product URL; basket_info; user_data; …).
Keep the tool — it covers ~35 operations with no typed equivalent (repo coverage docs).

### F-05 · P1 · Annotations incomplete
- `destructiveHint: true` never set explicitly on any mutating tool (S1: annotations
  describe behavior; S4: "tool annotations … disclose which tools make destructive
  changes").
- `openWorldHint` set on the 5 catalog tools but missing on all 36 account tools — every
  one of them calls alza.cz (open world).
- `idempotentHint` is broadly correct; keep.
**Fix:** explicit `destructiveHint: true` on all ~R tools, `openWorldHint: true` on all
remote tools.

### F-06 · P1 · Outputs: unbounded raw JSON, no concise channel, no outputSchema
All 36 account/advanced tools return `JSON.stringify(envelope, null, 2)` (~20 KB for
`cart`/`profile`/`router_product`) with low-signal fields (`vzt`, `serverTime`,
`user_name: ""`, `favCnt`) and no human-readable summary; catalog tools demonstrate the
better pattern (markdown + structured). No `outputSchema` anywhere (SDK 1.26 supports
it). S4: "return only high signal information … eschew low-level technical identifiers";
pagination/truncation with sensible defaults; `response_format` concise/detailed pattern.
S3: server-provided `outputSchema` enables typed programmatic tool calling.
**Fix:** (a) concise text summary (format.ts pattern) for the high-volume tools
(cart, profile, add_to_cart, order, mobile_read product ops) while keeping the full
envelope in `structuredContent`; (b) optional `detail: "concise"|"full"` parameter on
the three largest (cart, profile, mobile_read) — default concise for cart/profile;
(c) `outputSchema`: record as follow-up — upstream envelopes are dynamic (err/msg shape
stable, data shape per-operation), schema per tool is disproportionate; document in §Follow-ups.
**Errors:** Zod validation failures dump the whole schema (e.g. the 41-value operation
enum); S4/S5: actionable, specific errors. **Fix:** trim validation errors to the
offending field + expected value + one example.

### F-07 · P2 · Stale package/README descriptions
`package.json` description: "read-only interface to browse products, reviews, and
pickup points" — the server now exposes 36 authenticated account/checkout tools.
**Fix:** update `package.json` description + README "What it does" section to match.

### F-08 · P2 · Schema/behavior mismatches
1. `find_pickup_points` advertises `types: ["alzabox","branch"]` but only `branch` can
   return data (pickup.ts:39). S4: "avoid ambiguity by clearly describing (and
   enforcing with strict data models) expected inputs and outputs". **Fix:** description
   states `alzabox` currently returns no results (documented, not yet implemented); keep
   the enum value so the surface is stable when AlzaBox support lands (no new API
   surface now).
2. `prepare_mutation`'s action Zod enum (27 values) omits `web_place_order` and
   `web_after_order_payment`, which the tool's own description and the domain's
   `MUTATION_ACTIONS` (mobile-account.ts:6-17) both require — calling
   `prepare_mutation({action:"web_place_order"})` fails Zod validation today. **Fix:**
   add both values to the enum (29 actions).

### F-09 · P3 · Empty inputSchema
4 no-param tools pass `inputSchema: {}`. S2 (draft): prefer
`{ type: "object", additionalProperties: false }`. SDK-dependent; low risk. **Fix:**
apply if the SDK accepts it; otherwise record as SDK limitation.

### F-10 · P3 · Deterministic ordering (no action)
Tools register in fixed array order (S2: deterministic ordering enables client caching)
— already compliant.

## Consolidation analysis (task-4 input)

| Pair(s) | Verdict |
|---|---|
| `cart`/`add_to_cart`/`place_order`/`pay_after_order` vs `web_*` counterparts | **Keep both.** Different API stacks *and* contexts: mobile REST (authenticated account, OAuth) vs legacy web WCF (visitor basket, `Balancer-Guid`). The web WCF chain is the *working* order-submission path while mobile `sendOrder3` 500s (docs/gap-analysis.md G1/G5; `web_place_order` description already says so). Not overlapping functionality — different data domains. Description-level cross-references are the fix. |
| `mobile_read` vs typed tools | **Keep as escape hatch** (F-04): ~35 operations have no typed tool; disambiguate via description, not removal. |
| `chat_navigation` + `chat_send` | **Keep:** distinct purpose (chatbot W18 family), no typed equivalent. |
| `after_order_payments` vs `mobile_read(operation=web_after_payment_dialog)` | **Keep both:** typed (mobile API) vs raw (web dialog) — different payment id domains; cross-referenced in descriptions. |

**Result: no tool consolidations justified** — the surface is domain-distinct; the fix
is naming consistency + descriptions (F-01…F-04). Recorded per the goal's success
criterion ("or the audit explicitly records 'none justified'").

## Already good (do not regress)

- Catalog tools: agent-facing descriptions, per-parameter descriptions, examples,
  markdown + structured output, correct annotations.
- `prepare_mutation` / `mutate_list` / `web_place_order` / `web_pay_after_order`:
  exemplary DTO-level payload documentation with dated evidence.
- One-time confirmation-token flow for all high-impact mutations (client-side
  confirmation, per S1 security: "Prompt for user confirmation on sensitive operations").
- `title` on every tool (S1: human-readable display name).
- Zod input validation with meaningful bounds (S1: "Validate all tool inputs").
- structuredContent + TextContent on all tools (S1 backwards-compat rule).
- Server instructions, one resource, one guided prompt.
- Fixed registration order (F-10).

## Rename map (F-01)

| Old | New |
|---|---|
| `alza_auth_discovery` | `auth_discovery` |
| `alza_auth_start` | `auth_start` |
| `alza_auth_exchange` | `auth_exchange` |
| `alza_mobile_read` | `mobile_read` |
| `alza_prepare_mutation` | `prepare_mutation` |
| `alza_mutate_list` | `mutate_list` |
| `alza_account_status` | `account_status` |
| `alza_cart` | `cart` |
| `alza_add_to_cart` | `add_to_cart` |
| `alza_delivery_options` | `delivery_options` |
| `alza_select_pickup_point` | `select_pickup_point` |
| `alza_checkout_preview` | `checkout_preview` |
| `alza_place_order` | `place_order` |
| `alza_web_pickup_places` | `web_pickup_places` |
| `alza_web_add_to_cart` | `web_add_to_cart` |
| `alza_web_cart` | `web_cart` |
| `alza_chat_navigation` | `chat_navigation` |
| `alza_chat_send` | `chat_send` |
| `alza_profile` | `profile` |
| `alza_contacts` | `contacts` |
| `alza_register` | `register` |
| `alza_address_upsert` | `address_upsert` |
| `alza_address_delete` | `address_delete` |
| `alza_address_search` | `address_search` |
| `alza_payment_methods` | `payment_methods` |
| `alza_after_order_payments` | `after_order_payments` |
| `alza_pay_after_order` | `pay_after_order` |
| `alza_web_pay_after_order` | `web_pay_after_order` |
| `alza_order` | `order` |
| `alza_review_submit` | `review_submit` |
| `alza_complaint_claims` | `complaint_claims` |
| `alza_subscription_overview` | `subscription_overview` |
| `alza_subscription_activate` | `subscription_activate` |
| `alza_subscription_update_installment` | `subscription_update_installment` |
| `alza_upload_attachment` | `upload_attachment` |
| `alza_web_place_order` | `web_place_order` |

Unchanged: `search_products`, `get_product`, `get_product_reviews`,
`find_pickup_points`, `list_categories`.

## Follow-ups (out of scope for this goal, recorded)

- `outputSchema` per tool (F-06c) — disproportionate while envelopes are dynamic.
- AlzaBox pickup discovery (pickup.ts "v0.2") — new API surface, separate goal.
- `input_examples` (S5) — Claude-platform-specific field, not in the MCP tool
  definition; keep examples inside descriptions instead.
- Evaluation harness (S4) — agent-driven tool-use evals, separate goal.
