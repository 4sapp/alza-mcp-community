import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppActionExecutor } from "../src/infra/app-action.js";
import { ImpersonateTransport, cfFetch, candidatePythons } from "../src/infra/impersonate-transport.js";
import { MobileApi } from "../src/infra/mobile-api.js";

/**
 * Tests through the real sidecar protocol (scripts/cf-transport.py over stdio,
 * issue #80). Two interpreters:
 *  - a stub `curl_cffi` (plain http.client underneath, so it runs in CI where
 *    curl_cffi is not installed) that records what the script passes;
 *  - the real curl_cffi, when an interpreter with it is found locally.
 * All traffic goes to a local HTTP server.
 */

function hasPython(cmd: string, code = "import sys"): boolean {
  try {
    execFileSync(cmd, ["-c", code], { stdio: "ignore", env: { ...process.env, PYTHONPATH: "" }, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const python3 = hasPython("python3") ? "python3" : null;
const realCurlPython = candidatePythons().find((cmd) => hasPython(cmd, "import curl_cffi")) ?? null;

/** Stub curl_cffi: honours allow_redirects like curl_cffi does (follows 3xx by default). */
const STUB_REQUESTS = `
import http.client, time
from urllib.parse import urlsplit, urljoin

class _Resp:
    def __init__(self, status, headers, content):
        self.status_code = status
        self.headers = headers
        self.content = content

class Session:
    def __init__(self, impersonate=None, proxy=None):
        pass

    def request(self, method, url, headers=None, content=None, timeout=None, allow_redirects=True):
        for _ in range(5):
            u = urlsplit(url)
            conn = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
            conn.request(method, (u.path or "/") + (("?" + u.query) if u.query else ""), body=content, headers=headers or {})
            r = conn.getresponse()
            resp = _Resp(r.status, {k.lower(): v for k, v in r.getheaders()}, r.read())
            conn.close()
            if not (allow_redirects and 300 <= r.status < 400 and resp.headers.get("location")):
                return resp
            url = urljoin(url, resp.headers["location"])
        return resp
`;

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

async function startOrigin(): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
    if (req.url === "/api/redir-path") {
      res.writeHead(307, { location: "/Services/EShopService.svc/SendOrder4" });
      return res.end();
    }
    if (req.url === "/doc-redirect") {
      res.writeHead(302, { location: "/elsewhere.pdf" });
      return res.end();
    }
    if (req.url?.startsWith("/slow")) {
      setTimeout(() => res.end("slow"), 1500);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, seen };
}

/** AppActionExecutor requires an https origin; rewrite it onto the local server. */
function executorOver(transport: ImpersonateTransport, base: string): AppActionExecutor {
  const cf = cfFetch(transport);
  return new AppActionExecutor({
    baseUrl: "https://alza.test",
    visitorId: "visitor-1",
    authorizationToken: "secret-bearer",
    fetchImpl: (input, init) => cf(String(input).replace("https://alza.test", base), init),
  });
}

function sidecarSuite(label: string, pythonFor: () => string | null, setup?: () => () => void) {
  describe.skipIf(!pythonFor())(`cf sidecar protocol (${label})`, () => {
    let origin: Awaited<ReturnType<typeof startOrigin>>;
    let transport: ImpersonateTransport;
    let restore: (() => void) | undefined;
    const savedPython = process.env.ALZA_CF_PYTHON;

    beforeAll(async () => {
      restore = setup?.();
      process.env.ALZA_CF_PYTHON = pythonFor()!;
      origin = await startOrigin();
      transport = new ImpersonateTransport({ enabled: true, timeoutMs: 10_000 });
    });

    afterAll(async () => {
      transport?.close();
      await new Promise((resolve) => origin?.server.close(resolve));
      if (savedPython === undefined) delete process.env.ALZA_CF_PYTHON;
      else process.env.ALZA_CF_PYTHON = savedPython;
      restore?.();
    });

    it("returns the 3xx to the AppAction guard instead of replaying the POST and bearer token", async () => {
      origin.seen.length = 0;
      const executor = executorOver(transport, origin.base);
      await expect(
        executor.execute(
          { form: { meta: { href: "/api/redir-path", method: "POST" }, values: [{ name: "note", value: "x" }] } },
          { allowMutation: true, confirmationToken: "token-1" }
        )
      ).rejects.toThrow(/AppAction path is outside the allowlist|mutation redirects are blocked/);
      // Before the fix the sidecar followed the 307 itself: a second POST with the
      // same body and Authorization reached /Services/EShopService.svc/SendOrder4.
      expect(origin.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/redir-path"]);
    }, 20_000);

    it("still follows redirects when the caller does not ask for manual handling", async () => {
      origin.seen.length = 0;
      const res = await transport.request({ url: `${origin.base}/doc-redirect` });
      expect(res.status).toBe(200);
      expect(origin.seen.map((s) => s.url)).toEqual(["/doc-redirect", "/elsewhere.pdf"]);
    }, 20_000);

    it("hands the 3xx and its location back when followRedirects is false", async () => {
      origin.seen.length = 0;
      const res = await transport.request({ url: `${origin.base}/doc-redirect`, followRedirects: false });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/elsewhere.pdf");
      expect(origin.seen).toHaveLength(1);
    }, 20_000);

    it("does not hold a fast request behind a slow one (no head-of-line blocking)", async () => {
      const slow = transport.request({ url: `${origin.base}/slow` });
      await new Promise((r) => setTimeout(r, 50));
      const started = Date.now();
      const fast = await transport.request({ url: `${origin.base}/fast` });
      const fastMs = Date.now() - started;
      expect(fast.status).toBe(200);
      // Before the fix the sidecar handled one line at a time, so the fast request
      // waited for the 1.5 s one.
      expect(fastMs).toBeLessThan(1000);
      expect((await slow).body.toString()).toBe("slow");
    }, 20_000);
  });
}

sidecarSuite("stub curl_cffi", () => python3, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-stub-"));
  mkdirSync(path.join(dir, "curl_cffi"));
  writeFileSync(path.join(dir, "curl_cffi", "__init__.py"), "");
  writeFileSync(path.join(dir, "curl_cffi", "requests.py"), STUB_REQUESTS);
  const saved = process.env.PYTHONPATH;
  process.env.PYTHONPATH = dir;
  return () => {
    if (saved === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = saved;
    rmSync(dir, { recursive: true, force: true });
  };
});

sidecarSuite("real curl_cffi", () => realCurlPython);

describe("cfFetch redirect mode", () => {
  it("asks the sidecar not to follow when init.redirect is manual, and to follow otherwise", async () => {
    const seen: Array<boolean | undefined> = [];
    const transport = {
      request: vi.fn(async (req: { followRedirects?: boolean }) => {
        seen.push(req.followRedirects);
        return { status: 200, headers: {}, body: Buffer.from("{}") };
      }),
    } as unknown as ImpersonateTransport;
    await cfFetch(transport)("https://www.alza.cz/a", { redirect: "manual" });
    await cfFetch(transport)("https://www.alza.cz/b");
    expect(seen).toEqual([false, true]);
  });
});

describe("MobileApi.downloadDocument over the sidecar", () => {
  it("refuses a redirect instead of following it with the bearer token", async () => {
    const calls: Array<{ redirect?: string }> = [];
    const api = new MobileApi({
      loadTokenFile: false,
      httpFetch: async (_url, init) => {
        calls.push({ redirect: init.redirect });
        return { status: 302, text: async () => "", header: (n: string) => (n === "location" ? "https://evil.test/x" : null) };
      },
    });
    await expect(api.downloadDocument("https://www.alza.cz/doc.pdf")).rejects.toThrow(/redirected to a non-allowlisted location/);
    expect(calls).toEqual([{ redirect: "manual" }]);
  });
});
