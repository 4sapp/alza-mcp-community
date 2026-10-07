import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeBrowser extends EventEmitter {
  connected = true;
  contexts: FakeContext[] = [];
  isConnected() {
    return this.connected;
  }
  async newContext() {
    if (!this.connected) throw new Error("browser.newContext: Target page, context or browser has been closed");
    const ctx = new FakeContext(this);
    this.contexts.push(ctx);
    return ctx;
  }
  /** Simulates the user restarting Chrome. `emit` false mimics a missed event. */
  die(emit = true) {
    this.connected = false;
    if (emit) this.emit("disconnected");
  }
  async close() {}
}

class FakeContext {
  constructor(private readonly browser: FakeBrowser) {}
  async route() {}
  async newPage() {
    if (!this.browser.connected) throw new Error("browserContext.newPage: Target page, context or browser has been closed");
    return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async close() {} };
  }
  async close() {}
}

const browsers: FakeBrowser[] = [];
vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: vi.fn(async () => {
      const b = new FakeBrowser();
      browsers.push(b);
      return b;
    }),
  },
}));

const { AlzaBrowser } = await import("../src/infra/browser.js");

describe("AlzaBrowser attached over CDP", () => {
  beforeEach(() => {
    browsers.length = 0;
  });

  it("reconnects on the next call after Chrome restarts (disconnected event)", async () => {
    const b = new AlzaBrowser({ cdpUrl: "http://127.0.0.1:9333" });
    await b.withPage(async () => {});
    browsers[0]!.die();
    await expect(b.withPage(async () => "ok")).resolves.toBe("ok");
    expect(browsers).toHaveLength(2);
    await b.close();
  });

  it("recovers even when no disconnected event was delivered", async () => {
    const b = new AlzaBrowser({ cdpUrl: "http://127.0.0.1:9333" });
    await b.withPage(async () => {});
    browsers[0]!.die(false);
    await expect(b.withPage(async () => "ok")).resolves.toBe("ok");
    expect(browsers).toHaveLength(2);
    await b.close();
  });

  it("retries once when the target closes between the connectivity check and newPage", async () => {
    const b = new AlzaBrowser({ cdpUrl: "http://127.0.0.1:9333" });
    await b.withPage(async () => {});
    const first = browsers[0]!;
    // Stale: still reports connected, but its pages are gone.
    const ctx = first.contexts[0]!;
    ctx.newPage = async () => {
      throw new Error("browserContext.newPage: Target page, context or browser has been closed");
    };
    await expect(b.withPage(async () => "ok")).resolves.toBe("ok");
    expect(browsers).toHaveLength(2);
    await b.close();
  });
});
