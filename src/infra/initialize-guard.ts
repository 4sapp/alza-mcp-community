import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

/** JSON-RPC server-error code used for "request before the initialize handshake completed". */
export const SERVER_NOT_INITIALIZED = -32002;

type Handler = <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } =>
  "method" in m && "id" in m && m.id !== undefined && m.id !== null;

/**
 * Transport wrapper enforcing the MCP lifecycle: until the `initialize` request has been answered
 * successfully, every request other than `initialize` and `ping` is answered with a JSON-RPC error
 * and never reaches the server's handlers, and notifications are dropped. The SDK server itself
 * accepts such requests by default, so the guard sits between transport and server.
 */
export class InitializeGuardTransport implements Transport {
  private downstream?: Handler;
  private initializeIds = new Set<string | number>();
  private initialized = false;

  constructor(private readonly inner: Transport) {
    inner.onmessage = (message, extra) => this.incoming(message, extra);
  }

  private incoming(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (!this.initialized) {
      if (isRequest(message)) {
        if (message.method === "initialize") this.initializeIds.add(message.id);
        else if (message.method !== "ping") {
          void this.inner
            .send({ jsonrpc: "2.0", id: message.id, error: { code: SERVER_NOT_INITIALIZED, message: "Server not initialized: send an initialize request first" } })
            .catch((err) => this.inner.onerror?.(err instanceof Error ? err : new Error(String(err))));
          return;
        }
      } else if ("method" in message) {
        return; // notification before initialize: ignored
      }
    }
    this.downstream?.(message, extra);
  }

  async start(): Promise<void> {
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (!this.initialized && "result" in message && this.initializeIds.has(message.id)) {
      this.initialized = true;
      this.initializeIds.clear();
    } else if ("id" in message && ("result" in message || "error" in message)) {
      this.initializeIds.delete(message.id as string | number);
    }
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  get onmessage(): Handler | undefined {
    return this.downstream;
  }
  set onmessage(h: Handler | undefined) {
    this.downstream = h;
  }
  get onclose() {
    return this.inner.onclose;
  }
  set onclose(h: (() => void) | undefined) {
    this.inner.onclose = h;
  }
  get onerror() {
    return this.inner.onerror;
  }
  set onerror(h: ((error: Error) => void) | undefined) {
    this.inner.onerror = h;
  }
  get sessionId() {
    return this.inner.sessionId;
  }
  get setProtocolVersion() {
    return this.inner.setProtocolVersion?.bind(this.inner);
  }
}
