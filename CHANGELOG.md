# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-09-13

The repo version jumped from 0.1.2 (npm-published) straight to 0.3.0; npm still serves 0.1.2 — publishing is not part of this change. This entry documents everything on `main` since 0.1.2, grouped by theme.

### Added

- **Full practical Alza API surface** (36 account tools over 5 catalog tools — 41 total): anonymous + authenticated account stack — auth PKCE sign-in, mobile reads via a 38-operation `alza_mobile_read` whitelist, typed high-impact mutations (cart, delivery/pickup, checkout preview + place order, profile/addresses, payments, orders, review submit, complaints, subscriptions, attachment upload), and the legacy web WCF checkout/order/payment family. Two-step mutation design: mutating tools return a one-time confirmation token bound to exactly one action; the actual call goes out only on a follow-up `mutate_list`/typed mutation with that token.
- **Per-tool outputSchema** (41 tools): loose envelope schema (`err`/`msg`/`data`) on the raw tools; typed schemas on `auth_discovery` (OIDC document), `auth_start`, `prepare_mutation`, `account_status`, `checkout_preview`, `web_pickup_places`, and all 5 catalog tools. SDK validates each call's `structuredContent` against the published schema.
- **Agent-driven eval harness** (`npm run eval`): 6 non-mutating scenarios over the in-memory transport (registration surface, catalog read, auth discovery, account status, account read, input-validation error quality); per-check observed values land in `docs/live-evidence/eval-<date>.json`.
- **pi gateway integration**: pi exposes the 41 tools under the `alza_` prefix; verified in-session and headlessly (3 scripted `pi -p` runs, `docs/live-evidence/headless-pi-2026-09-13.json`).
- MCP best-practices audit trail: `docs/mcp-best-practices-audit.md` (F-01…F-10 fixes, 2026-09-13 re-audit regression table, N-1…N-4).

### Changed

- **Naming convention unified to bare tool names** (36 tools dropped the redundant `alza_` server-name prefix).
- **Descriptions rewritten agent-facing** (what/when/when-not/prerequisites/side effects per tool), stale v0.1/v0.2 caveats removed.
- **Annotations completed and harmonized**: readOnly/destructive/modifier hints on all 41 tools; destructive=true on exactly the 8 high-impact calls; 18 mutating tools correctly marked `readOnly: false`.
- **Concise text channel + bounded raw envelopes**: raw tools return the upstream JSON in `structuredContent` with a short human-readable text block; cart/checkout/order responses are summarized.
- **Catalog search**: price/rating sorting applied client-side to the fetched page (Alza honors no sort server-side) with an honest description; `in_stock` filter.

### Fixed

- Browser memory leak and idle shutdown (carried over from 0.1.1 fixes, kept in 0.3.0).
- `find_pickup_points` no longer documents a non-existent AlzaBox surface; stale v0.2 pickup comments removed.
- Deterministic tool registration order (catalog → account → advanced) and wire-level annotation-contract tests.

## [0.1.2] — 2026-05-11

### Added
- 🎉 **Published to npm** as [`alza-mcp`](https://www.npmjs.com/package/alza-mcp). The one-line install (`claude mcp add alza --scope user -- npx -y alza-mcp`) now actually works.

### Changed
- Honest tool descriptions for known v0.1 partial-failures. `get_product_reviews` now states it returns aggregate ratings only (individual review bodies are v0.2). `get_product` notes that the `params` spec table is often empty in v0.1.

### Removed
- Dead `fetchAllAlzaboxes()` HTTP code in `pickup.ts` — `api.alzabox.cz` no longer resolves and we never used it. AlzaBox discovery returns in v0.2 via DOM scrape of the public locker map.



## [0.1.1] — 2026-05-09

### Fixed
- **Memory leak.** The browser used to hold up to 4 pooled pages forever, and one of them ballooned to ~1.9 GB after a few searches because pooled pages accumulate DOM/JS heap across navigations. Pages are now closed after each tool call.
- **Browser never shut down.** Once launched, the headless Chromium ran until the MCP process itself exited — meaning a long-running Claude Code session held a few hundred MB of headless-shell forever. Browser now auto-closes after 3 minutes of tool inactivity (`ALZA_IDLE_TTL_MS` to override). Next tool call relaunches transparently.

Memory profile after the fix: ~215 MB peak during active use, **0 MB** within 3 minutes of the last tool call. Was 4+ GB and growing.

### Added
- `ALZA_IDLE_TTL_MS` env var to tune the idle-shutdown window.



## [0.1.0] — 2026-05-09

### Added
- Initial release. Read-only MCP server for Alza.cz over stdio.
- Tools: `search_products`, `get_product`, `get_product_reviews`, `find_pickup_points`, `list_categories`.
- Resource: `alza://product/{code}`.
- Prompt: `find-product`.
- Cloudflare-aware HTTP client with mobile-app fingerprint, handshake, cookie jar, retry, and proxy hook.
- AlzaBox API integration for parcel-locker discovery.
- Static dataset of major Alza brick-and-mortar branches.
- Locales: `.cz`, `.sk`, `.hu`, `.at`, `.de`, `.co.uk`.
- `validate-api` script for upstream drift detection.
