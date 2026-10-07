import { ConfigurationError } from "./errors.js";

/**
 * `ALZA_PROXY_URL`: route Alza traffic through an HTTP(S) or SOCKS5 proxy, e.g. a
 * residential proxy when the host's own IP is challenged by Cloudflare (datacenter
 * and CI runners are; see docs/gap-analysis.md). Applies to the managed Chromium
 * and the curl_cffi sidecar (which reads the same variable). While it is set, the
 * mobile API never falls back to an un-proxied plain fetch (see MobileApi).
 * An invalid value is a ConfigurationError; the entrypoint checks it at startup.
 */
export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

const SCHEMES = new Set(["http:", "https:", "socks5:"]);

/** True when ALZA_PROXY_URL is set (non-blank), whether or not it is valid. */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ALZA_PROXY_URL?.trim());
}

function decodeCredential(value: string, field: "username" | "password"): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConfigurationError(`ALZA_PROXY_URL ${field} contains an invalid percent-escape (encode a literal % as %25)`);
  }
}

export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): PlaywrightProxy | undefined {
  const raw = env.ALZA_PROXY_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("ALZA_PROXY_URL is not a valid URL (expected http://[user:pass@]host:port or socks5://host:port)");
  }
  if (!SCHEMES.has(url.protocol)) {
    throw new ConfigurationError(`ALZA_PROXY_URL scheme ${url.protocol} is not supported (use http, https or socks5)`);
  }
  if (!url.hostname) {
    throw new ConfigurationError("ALZA_PROXY_URL has no host (expected http://[user:pass@]host:port or socks5://host:port)");
  }
  return {
    // Playwright takes credentials separately from the server URL.
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeCredential(url.username, "username") } : {}),
    ...(url.password ? { password: decodeCredential(url.password, "password") } : {}),
  };
}
