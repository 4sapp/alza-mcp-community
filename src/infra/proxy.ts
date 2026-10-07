/**
 * `ALZA_PROXY_URL`: route Alza traffic through an HTTP(S) or SOCKS5 proxy, e.g. a
 * residential proxy when the host's own IP is challenged by Cloudflare (datacenter
 * and CI runners are; see docs/gap-analysis.md). Applies to the managed Chromium
 * and the curl_cffi sidecar (which reads the same variable). Plain-fetch fallbacks
 * are not proxied.
 */
export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

const SCHEMES = new Set(["http:", "https:", "socks5:"]);

export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): PlaywrightProxy | undefined {
  const raw = env.ALZA_PROXY_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ALZA_PROXY_URL is not a valid URL (expected http://[user:pass@]host:port or socks5://host:port)");
  }
  if (!SCHEMES.has(url.protocol)) {
    throw new Error(`ALZA_PROXY_URL scheme ${url.protocol} is not supported (use http, https or socks5)`);
  }
  return {
    // Playwright takes credentials separately from the server URL.
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}
