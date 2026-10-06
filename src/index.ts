#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliConfig, startHttpServer } from "./http.js";
import { log } from "./infra/logger.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = parseCliConfig(process.argv.slice(2));
  if (config.transport === "http") return mainHttp(config.http);

  const { server, close } = buildServer({
    baseUrl: process.env.ALZA_BASE_URL,
    cdpUrl: process.env.ALZA_CDP_URL,
  });

  const shutdown = async (signal: string) => {
    log.info(`alza-mcp shutting down on ${signal}`);
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("alza-mcp ready", {
    baseUrl: process.env.ALZA_BASE_URL ?? "https://www.alza.cz",
    cdp: !!process.env.ALZA_CDP_URL,
  });
}

async function mainHttp(opts: Parameters<typeof startHttpServer>[0]): Promise<void> {
  const running = await startHttpServer(opts);
  const shutdown = async (signal: string) => {
    log.info(`alza-mcp shutting down on ${signal}`);
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log.info("alza-mcp ready (Streamable HTTP)", {
    url: running.url,
    baseUrl: process.env.ALZA_BASE_URL ?? "https://www.alza.cz",
    account: opts?.allowAccount ?? false,
    tokenFile: Boolean(opts?.allowAccount && opts?.allowTokenFile),
  });
}

main().catch((err) => {
  log.error("fatal", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
