import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AlzaBrowser } from "./infra/browser.js";
import { ImpersonateTransport } from "./infra/impersonate-transport.js";
import { log } from "./infra/logger.js";
import { buildServer, type BuildResult } from "./server.js";
import { TOOLSET_DEFS, type LockedToolsets } from "./tools/toolsets.js";

/**
 * MCP Streamable HTTP transport (issue #16).
 *
 * Security model — a networked endpoint can be reached by more than one client,
 * so the HTTP mode is deliberately stricter than stdio:
 *
 *  - Every MCP session (`Mcp-Session-Id`) gets its OWN `McpServer` built by
 *    `buildServer`: its own toolset enable/disable state, its own `MobileApi`
 *    (OAuth access/refresh tokens, PKCE verifier) and its own `MobileAccount`
 *    (one-time mutation / checkout confirmation tokens). Nothing account-related
 *    is shared between sessions.
 *  - Only the read-only `catalog` toolset is usable by default. Every other
 *    toolset (auth, basket/checkout, account, orders/payments, reviews/
 *    subscriptions, chat, raw mobile reads) is LOCKED: still listed by
 *    `list_toolsets` with the reason, but `set_toolset` refuses to enable it.
 *    The operator opts in with `ALZA_HTTP_ENABLE_ACCOUNT=1`.
 *  - With the account opt-in, each session also gets its own browser context
 *    and its own Chrome-fingerprint sidecar (both lazy), because both keep a
 *    cookie jar for Alza and must not carry one user's cookies into another
 *    user's requests. In catalog-only mode they are shared (public reads only).
 *  - `ALZA_TOKEN_FILE` (a single-user OAuth token store) is never auto-loaded in
 *    HTTP mode unless the operator additionally sets `ALZA_HTTP_ALLOW_TOKEN_FILE=1`
 *    — meant for a single-user localhost setup only; every session then starts
 *    signed in as that one account.
 *  - Binds to 127.0.0.1 by default and validates `Host`/`Origin` against an
 *    allow-list (DNS-rebinding protection for a localhost server).
 */

export const ACCOUNT_LOCK_REASON =
  "Disabled on the Streamable HTTP transport: a networked MCP endpoint can be reached by more than one client, and these tools sign in to and act on a real Alza account (orders, payments, credentials). " +
  "The server operator can opt in with ALZA_HTTP_ENABLE_ACCOUNT=1; each MCP session then has its own isolated OAuth login and confirmation tokens.";

export interface HttpServerOptions {
  /** TCP port; 0 picks a free one. Default 3000. */
  port?: number;
  /** Bind address. Default 127.0.0.1 (localhost only). */
  host?: string;
  /** MCP endpoint path. Default /mcp. */
  path?: string;
  /** Unlock the account/checkout toolsets (ALZA_HTTP_ENABLE_ACCOUNT=1). Default false. */
  allowAccount?: boolean;
  /** Auto-load ALZA_TOKEN_FILE into every session (ALZA_HTTP_ALLOW_TOKEN_FILE=1). Requires allowAccount. Default false. */
  allowTokenFile?: boolean;
  /** Accepted Host/Origin hostnames. Default: loopback names when bound to loopback, otherwise no check. */
  allowedHosts?: string[];
  /** Concurrent session cap. Default 50. */
  maxSessions?: number;
  /** Close a session after this many ms without a request. Default 30 min. */
  sessionIdleMs?: number;
  baseUrl?: string;
  cdpUrl?: string;
}

export interface RunningHttpServer {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:3000/mcp */
  url: string;
  port: number;
  sessionCount: () => number;
  close: () => Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  built: BuildResult;
  lastSeen: number;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Hostname part of a Host header value (`example.com:3000`, `[::1]:3000`). */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? h;
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Locked toolsets for an HTTP deployment: everything but `catalog` unless opted in. */
export function httpLockedToolsets(allowAccount: boolean): LockedToolsets {
  if (allowAccount) return {};
  return Object.fromEntries(TOOLSET_DEFS.filter((d) => d.id !== "catalog").map((d) => [d.id, ACCOUNT_LOCK_REASON]));
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const allowAccount = opts.allowAccount ?? false;
  const allowTokenFile = allowAccount && (opts.allowTokenFile ?? false);
  if (opts.allowTokenFile && !allowAccount) {
    log.warn("http: ALZA_HTTP_ALLOW_TOKEN_FILE ignored — it requires ALZA_HTTP_ENABLE_ACCOUNT=1");
  }
  const maxSessions = opts.maxSessions ?? 50;
  const sessionIdleMs = opts.sessionIdleMs ?? 30 * 60 * 1000;
  const allowedHosts = (opts.allowedHosts && opts.allowedHosts.length > 0
    ? opts.allowedHosts
    : isLoopback(host) ? LOOPBACK_HOSTS : []
  ).map((h) => h.toLowerCase());
  if (!isLoopback(host)) {
    log.warn("http: listening on a non-loopback address — put this behind TLS and an authenticating proxy", { host, allowedHosts });
  }

  const locked = httpLockedToolsets(allowAccount);
  // Catalog-only: one browser + sidecar for every session (public, anonymous reads).
  // Account mode: per-session instances, so cookie jars are never shared.
  const shared = allowAccount
    ? undefined
    : { browser: new AlzaBrowser({ baseUrl: opts.baseUrl, cdpUrl: opts.cdpUrl }), cfTransport: new ImpersonateTransport() };
  const instructionsNote = allowAccount
    ? "Served over Streamable HTTP: this MCP session has its own isolated OAuth login and confirmation tokens" +
      (allowTokenFile ? " (pre-loaded from the operator's ALZA_TOKEN_FILE)." : "; sign in with `auth_start` → `auth_exchange`.")
    : "Served over Streamable HTTP: only the read-only `catalog` toolset is available on this deployment; the auth, account, basket/checkout, order and payment toolsets are locked (see `list_toolsets`).";

  const sessions = new Map<string, Session>();

  const closeSession = async (id: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => {});
    await s.built.close().catch(() => {});
    log.info("http: session closed", { sessions: sessions.size });
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > sessionIdleMs) void closeSession(id);
    }
  }, Math.min(60_000, Math.max(1_000, Math.floor(sessionIdleMs / 2))));
  sweep.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (allowedHosts.length > 0) {
      const hostHeader = req.headers.host;
      if (!hostHeader || !allowedHosts.includes(hostnameOf(hostHeader))) {
        return jsonRpcError(res, 403, `Invalid Host header: ${hostHeader ?? "(missing)"}`);
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string;
        try { originHost = new URL(origin).hostname.toLowerCase(); } catch { originHost = ""; }
        if (!allowedHosts.includes(originHost) && !allowedHosts.includes(`[${originHost}]`)) {
          return jsonRpcError(res, 403, `Invalid Origin header: ${origin}`);
        }
      }
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, transport: "streamable-http", sessions: sessions.size, account: allowAccount }));
      return;
    }
    if (url.pathname !== path) return jsonRpcError(res, 404, `Not found; the MCP endpoint is ${path}`);

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return jsonRpcError(res, 404, "Unknown or expired session; re-initialize");
      s.lastSeen = Date.now();
      await s.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") return jsonRpcError(res, 400, "Missing Mcp-Session-Id header");
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return jsonRpcError(res, 400, `Invalid request body: ${(err as Error).message}`);
    }
    if (!isInitializeRequest(body)) return jsonRpcError(res, 400, "Missing Mcp-Session-Id header (only an initialize request may omit it)");
    if (sessions.size >= maxSessions) return jsonRpcError(res, 503, "Too many concurrent sessions; try again later");

    const built = buildServer({
      baseUrl: opts.baseUrl,
      cdpUrl: opts.cdpUrl,
      browser: shared?.browser,
      cfTransport: shared?.cfTransport,
      lockedToolsets: locked,
      loadTokenFile: allowTokenFile,
      instructionsNote,
    });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, built, lastSeen: Date.now() });
        log.info("http: session opened", { sessions: sessions.size });
      },
      onsessionclosed: (id) => closeSession(id),
    });
    transport.onclose = () => {
      if (transport.sessionId) void closeSession(transport.sessionId);
    };
    await built.server.connect(transport);
    await transport.handleRequest(req, res, body);
    if (!transport.sessionId || !sessions.has(transport.sessionId)) {
      // Initialization was rejected — nothing references this server any more.
      await built.close().catch(() => {});
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error("http: request failed", { error: (err as Error).message });
      jsonRpcError(res, 500, "Internal server error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3000, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const displayHost = host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${displayHost}:${port}${path}`,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      shared?.cfTransport.close();
      await shared?.browser.close();
    },
  };
}

export interface CliConfig {
  transport: "stdio" | "http";
  http: HttpServerOptions;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parse `--http [--port N] [--host H]` and the ALZA_TRANSPORT / ALZA_HTTP_* env vars. */
export function parseCliConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  let transport: "stdio" | "http" = env.ALZA_TRANSPORT?.toLowerCase() === "http" ? "http" : "stdio";
  if (env.ALZA_TRANSPORT && !["http", "stdio"].includes(env.ALZA_TRANSPORT.toLowerCase())) {
    throw new Error(`ALZA_TRANSPORT must be "stdio" or "http" (got "${env.ALZA_TRANSPORT}")`);
  }
  let port: string | undefined = env.ALZA_HTTP_PORT ?? env.PORT;
  let host: string | undefined = env.ALZA_HTTP_HOST;
  let portFromArgv = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "--http") transport = "http";
    else if (flag === "--stdio") transport = "stdio";
    else if (flag === "--port" || flag === "--host") {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === "--port") { port = value; portFromArgv = true; } else host = value;
    } else {
      throw new Error(`Unknown argument "${arg}". Usage: alza-mcp [--http [--port N] [--host H]]`);
    }
  }
  if (portFromArgv && transport !== "http") throw new Error("--port only applies with --http (or ALZA_TRANSPORT=http)");
  let portNum: number | undefined;
  if (port !== undefined) {
    portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) throw new Error(`Invalid port "${port}"`);
  }
  const allowedHosts = env.ALZA_HTTP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  const idle = Number(env.ALZA_HTTP_SESSION_IDLE_MS);
  const max = Number(env.ALZA_HTTP_MAX_SESSIONS);
  return {
    transport,
    http: {
      port: portNum,
      host,
      allowAccount: TRUTHY.has((env.ALZA_HTTP_ENABLE_ACCOUNT ?? "").toLowerCase()),
      allowTokenFile: TRUTHY.has((env.ALZA_HTTP_ALLOW_TOKEN_FILE ?? "").toLowerCase()),
      allowedHosts,
      maxSessions: Number.isInteger(max) && max > 0 ? max : undefined,
      sessionIdleMs: Number.isFinite(idle) && idle > 0 ? idle : undefined,
      baseUrl: env.ALZA_BASE_URL,
      cdpUrl: env.ALZA_CDP_URL,
    },
  };
}
