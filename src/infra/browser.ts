import { spawn } from "node:child_process";
import { proxyFromEnv } from "./proxy.js";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveLocale, type Locale } from "./locale.js";
import { log } from "./logger.js";

const require = createRequire(import.meta.url);

const PAGE_TIMEOUT_MS = 30_000;
const HEADER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DEFAULT_IDLE_BROWSER_TTL_MS = 3 * 60 * 1000;

export interface BrowserOptions {
  baseUrl?: string;
  /** Connect to an existing Chrome via CDP instead of launching Chromium. */
  cdpUrl?: string;
  /** Set false to run a visible window (debugging only). Default true. */
  headless?: boolean;
  /** Close the browser entirely after this many ms of inactivity. Default 3 min. */
  idleTtlMs?: number;
}

/**
 * Lazy, idle-shutdown browser facade.
 *
 * Design notes:
 *  - The browser is launched on first use, NOT eagerly.
 *  - Pages are NOT pooled. Each `withPage` call opens a fresh page and
 *    closes it in a finally — pages accumulate DOM/JS heap across
 *    navigations and pooling them caused 1.9 GB renderer leaks.
 *  - When no calls have been made for `idleTtlMs`, the entire browser
 *    process tree is shut down. Next call relaunches.
 *  - Image/font/media/analytics traffic is blocked at the route level so
 *    every page load is just HTML + JSON-LD.
 */
export class AlzaBrowser {
  readonly locale: Locale;
  get baseUrl(): string {
    return this.locale.baseUrl;
  }
  private readonly cdpUrl?: string;
  private readonly headless: boolean;
  private readonly idleTtlMs: number;

  private launching?: Promise<Browser>;
  private browser?: Browser;
  private context?: BrowserContext;
  private idleTimer?: NodeJS.Timeout;
  private inFlight = 0;
  private closed = false;

  constructor(opts: BrowserOptions = {}) {
    this.locale = resolveLocale(opts.baseUrl);
    this.cdpUrl = opts.cdpUrl ?? process.env.ALZA_CDP_URL;
    this.headless = opts.headless ?? process.env.ALZA_HEADLESS !== "false";
    const envTtl = Number(process.env.ALZA_IDLE_TTL_MS);
    this.idleTtlMs =
      opts.idleTtlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_IDLE_BROWSER_TTL_MS);
  }

  /**
   * Run an async function with a fresh page. The page is opened just
   * before the callback and closed unconditionally afterward.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("browser closed");

    this.cancelIdleTimer();
    this.inFlight++;
    let page: Page | undefined;
    try {
      try {
        page = await (await this.ensureContext()).newPage();
      } catch (err) {
        // The browser vanished between calls (e.g. the user restarted the Chrome we attached
        // to over CDP): drop the stale handles and retry once on a fresh connection.
        if (!/has been closed|disconnected|Target closed/i.test((err as Error)?.message ?? "")) throw err;
        log.info("alza-browser: browser went away, reconnecting");
        await this.dropBrowser();
        page = await (await this.ensureContext()).newPage();
      }
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
      return await fn(page);
    } finally {
      if (page) await page.close().catch(() => {});
      this.inFlight--;
      if (this.inFlight === 0) this.scheduleIdleShutdown();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelIdleTimer();
    await this.shutdownBrowser();
  }

  private async shutdownBrowser(): Promise<void> {
    const ctx = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;

    await ctx?.close().catch(() => {});

    if (this.cdpUrl) {
      // We attached to a user's Chrome — never close it.
      return;
    }
    await browser?.close().catch(() => {});
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      log.info("alza-browser: closing idle browser", { idleMs: this.idleTtlMs });
      void this.shutdownBrowser();
    }, this.idleTtlMs);
    // Don't keep the process alive solely for this timer (matters for stdio).
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Forget the current browser/context without closing anything (they are already gone). */
  private async dropBrowser(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.browser = undefined;
    await ctx?.close().catch(() => {});
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.browser && !this.browser.isConnected()) await this.dropBrowser();
    if (this.context) return this.context;
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      locale: this.locale.acceptLanguage.split(",")[0] ?? "cs-CZ",
      userAgent: HEADER_USER_AGENT,
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "accept-language": this.locale.acceptLanguage },
    });

    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      const url = route.request().url();
      if (
        url.includes("googletagmanager.com") ||
        url.includes("google-analytics.com") ||
        url.includes("doubleclick.net") ||
        url.includes("/api/log/")
      ) {
        return route.abort();
      }
      return route.continue();
    });

    this.context = context;
    return context;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      if (this.cdpUrl) {
        log.info("alza-browser: connecting via CDP", { cdpUrl: this.cdpUrl });
        const browser = await chromium.connectOverCDP(this.cdpUrl);
        this.browser = browser;
        this.watchDisconnect(browser);
        return browser;
      }
      log.info("alza-browser: launching managed Chromium", { headless: this.headless });
      const browser = await this.launchChromiumWithFallback();
      this.browser = browser;
      this.watchDisconnect(browser);
      return browser;
    })().finally(() => {
      this.launching = undefined;
    });

    return this.launching;
  }

  /** External shutdown (crash, user restarted Chrome) — clear refs so the next call reconnects/relaunches. */
  private watchDisconnect(browser: Browser): void {
    browser.on("disconnected", () => {
      log.info("alza-browser: browser disconnected");
      if (this.browser !== browser) return;
      this.browser = undefined;
      this.context = undefined;
    });
  }

  private async launchChromiumWithFallback(): Promise<Browser> {
    const proxy = proxyFromEnv();
    if (proxy) log.info("alza-browser: routing Chromium through ALZA_PROXY_URL", { server: proxy.server });
    const launchArgs = {
      headless: this.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        // Trim memory / process count.
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-default-browser-check",
        "--no-first-run",
      ],
      ...(proxy ? { proxy } : {}),
    };
    try {
      return await chromium.launch(launchArgs);
    } catch (err) {
      const message = (err as Error)?.message ?? "";
      const isMissingBinary =
        message.includes("Executable doesn't exist") ||
        message.includes("Looks like Playwright Test or Playwright was just installed");
      if (!isMissingBinary) throw err;

      log.info(
        "alza-browser: chromium not found — downloading headless-shell now (~92 MB, one-time). " +
          "Set ALZA_CDP_URL to skip the download and use your own Chrome."
      );
      await ensureChromiumInstalled();
      return chromium.launch(launchArgs);
    }
  }
}

/**
 * Downloads the Chromium headless shell via Playwright's CLI. The child's stdout is sent to our
 * stderr: on a stdio server stdout is the JSON-RPC channel, and Playwright's progress output
 * ("Downloading Chrome Headless Shell …") would corrupt it. `installer` overrides the command (tests).
 */
export async function ensureChromiumInstalled(installer?: { command: string; args: string[] }): Promise<void> {
  let cliPath = "";
  if (!installer) try {
    const path = await import("node:path");
    const pkgJsonPath = require.resolve("playwright/package.json");
    cliPath = path.join(path.dirname(pkgJsonPath), "cli.js");
  } catch (err) {
    throw new Error(
      "Cannot find Playwright CLI. Run `npm install playwright` and retry.",
      { cause: err as Error }
    );
  }
  await new Promise<void>((resolve, reject) => {
    const command = installer?.command ?? process.execPath;
    const args = installer?.args ?? [cliPath, "install", "chromium", "--only-shell"];
    const child = spawn(command, args, { stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Failed to install Chromium (exit ${code}). Try \`npx playwright install chromium --only-shell\` manually.`
          )
        );
    });
  });
}
