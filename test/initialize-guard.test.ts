import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { InitializeGuardTransport } from "../src/infra/initialize-guard.js";
import { buildServer } from "../src/server.js";

process.env.ALZA_TOKEN_FILE = "none";

const indexTs = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } };
const CALL = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_toolsets", arguments: {} } };

describe("initialize guard (in-memory, raw JSON-RPC)", () => {
  async function rawPair() {
    const built = buildServer();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await built.server.connect(new InitializeGuardTransport(s));
    const received: JSONRPCMessage[] = [];
    c.onmessage = (m) => received.push(m);
    await c.start();
    const waitFor = async (n: number) => {
      for (let i = 0; i < 200 && received.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    };
    return { built, c, received, waitFor };
  }

  it("rejects requests before initialize with -32002, ignores notifications, answers ping, then works normally", async () => {
    const { built, c, received, waitFor } = await rawPair();
    try {
      await c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await c.send(CALL as JSONRPCMessage);
      await c.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      await c.send({ jsonrpc: "2.0", id: 4, method: "ping" });
      await waitFor(3);
      expect(received).toHaveLength(3);
      const byId = new Map(received.map((m) => [(m as { id: number }).id, m as { error?: { code: number }; result?: unknown }]));
      expect(byId.get(2)?.error?.code).toBe(-32002);
      expect(byId.get(3)?.error?.code).toBe(-32002);
      expect(byId.get(4)?.result).toEqual({});

      await c.send(INIT as JSONRPCMessage);
      await waitFor(4);
      expect((received[3] as { result?: { serverInfo?: unknown } }).result?.serverInfo).toBeDefined();
      await c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await c.send(CALL as JSONRPCMessage);
      await waitFor(5);
      const ok = received[4] as { result?: { isError?: boolean }; error?: unknown };
      expect(ok.error).toBeUndefined();
      expect(ok.result?.isError).toBeFalsy();
    } finally {
      await c.close();
      await built.close();
    }
  });

  it("a failed initialize does not open the gate", async () => {
    const { built, c, received, waitFor } = await rawPair();
    try {
      await c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { nope: true } } as JSONRPCMessage);
      await waitFor(1);
      expect((received[0] as { error?: unknown }).error).toBeDefined();
      await c.send(CALL as JSONRPCMessage);
      await waitFor(2);
      expect((received[1] as { error?: { code: number } }).error?.code).toBe(-32002);
    } finally {
      await c.close();
      await built.close();
    }
  });
});

describe("initialize guard (stdio child process)", () => {
  it("rejects tools/call before initialize, still -32700 for malformed JSON, works after the handshake", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", indexTs], {
      env: { ...process.env, ALZA_TOKEN_FILE: "none" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l.startsWith("{")) lines.push(JSON.parse(l));
      }
    });
    const send = (m: object | string) => child.stdin.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 300; i++) {
        const hit = lines.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("timeout waiting for reply; got " + JSON.stringify(lines));
    };
    try {
      send(CALL);
      const early = await waitFor((m) => m.id === 2);
      expect((early.error as { code: number }).code).toBe(-32002);
      expect(early.result).toBeUndefined();

      send("{not json");
      const parse = await waitFor((m) => m.id === null);
      expect((parse.error as { code: number }).code).toBe(-32700);

      send(INIT);
      await waitFor((m) => m.id === 1 && m.result !== undefined);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ ...CALL, id: 5 });
      const ok = await waitFor((m) => m.id === 5);
      expect(ok.error).toBeUndefined();
      expect(ok.result).toBeDefined();
    } finally {
      child.kill("SIGTERM");
    }
  }, 30000);
});

describe("initialize guard (Streamable HTTP)", () => {
  let server: RunningHttpServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const post = async (url: string, body: object, sid?: string) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } : {}) },
      body: JSON.stringify(body),
    });
    return { res, text: await res.text() };
  };

  it("HTTP stays unchanged: no session without initialize; session works right after the initialize response", async () => {
    server = await startHttpServer({ port: 0 });
    const before = await post(server.url, CALL);
    expect(before.res.status).toBe(400);
    const init = await post(server.url, INIT);
    expect(init.res.status).toBe(200);
    const sid = init.res.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    const call = await post(server.url, CALL, sid);
    expect(call.res.status).toBe(200);
    expect(call.text).toContain('"result"');
    expect(call.text).not.toContain("-32002");
  });
});
