# Streamable HTTP transport — live check (2026-10-06)

Issue: [#16](https://github.com/lukabudik/alza-mcp/issues/16). Build: branch `feat/streamable-http`, `npm run build`, `node dist/index.js`.
Egress: residential IP (same host as the other live evidence). `ALZA_TOKEN_FILE=none` for every run, so no stored login was used.
Chrome-fingerprint sidecar: `ALZA_CF_PYTHON` pointing at a `curl_cffi` venv. Client: `@modelcontextprotocol/sdk` 1.29.0 `Client` + `StreamableHTTPClientTransport`.

| # | Check | Result | Label |
|---|---|---|---|
| 1 | `node dist/index.js --http --port 38917`, `GET /healthz` | `{"ok":true,"transport":"streamable-http","sessions":0,"account":false}` | live-verified |
| 2 | Default mode: `tools/list` over HTTP | 8 tools: the 6 `catalog` tools + `list_toolsets` + `set_toolset` | live-verified |
| 3 | Default mode: `search_products {query:"usb-c kabel", limit:3}` | 3 real alza.cz results (prices, stock, URLs), about 1.4 s including Chromium launch | live-verified |
| 4 | Default mode: `set_toolset {id:"basket_and_checkout", enabled:true}` | `isError: true`: `Toolset "basket_and_checkout" is locked on this deployment: …ALZA_HTTP_ENABLE_ACCOUNT=1…` | live-verified |
| 5 | Session DELETE (`terminateSession`) then SIGINT | log shows `http: session closed`, then a clean shutdown with Chromium closed | live-verified |
| 6 | `ALZA_TRANSPORT=http ALZA_HTTP_PORT=38918 ALZA_HTTP_ENABLE_ACCOUNT=1` (env-only start) | `/healthz` reports `"account":true`; `tools/list` shows 13 tools (catalog + auth + toolset tools) | live-verified |
| 7 | Account mode, two concurrent sessions A and B: A enables `basket_and_checkout` | A sees 25 tools, B still sees 13 (toolset state is per session) | live-verified |
| 8 | Account mode: `account_status` in A and B | both `authenticated: false`; the visitor ids differ (separate `MobileApi` per session) | live-verified |
| 9 | Account mode: `auth_discovery` in A | OIDC discovery from `https://identity.alza.cz` returned through A's own sidecar (log: `cf-transport: sidecar ready`, then `sidecar exited` when A's session closed) | live-verified |
| 10 | Mutation-token isolation (token from `prepare_mutation` in A, used with `mutate_list` in B) | rejected with `Invalid or expired mutation confirmation token` before any Alza request | source-confirmed + vitest (`test/http-transport.test.ts`); not sent to Alza on purpose |
| 11 | `ALZA_TOKEN_FILE` with a token present: not loaded on HTTP unless `ALZA_HTTP_ALLOW_TOKEN_FILE=1` + `ALZA_HTTP_ENABLE_ACCOUNT=1` | covered with a fake token file in vitest; not run against the real token store, which another agent was using | source-confirmed + vitest |
| 12 | Hosted deployment (datacenter IP) | not attempted. Hosting is a follow-up in #16, and the Cloudflare datacenter-IP constraint is written up in the README | unresolved |

No personal data was involved: no login, no account reads, and no mutations were sent to Alza.
