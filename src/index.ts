#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer, shutdownRuntime } from "./server.js";

const handle = serveStdio(() => buildServer());

console.error("[japan-cinema-browser-mcp] listening on stdio");

async function shutdown(): Promise<void> {
  await handle.close().catch(() => undefined);
  await shutdownRuntime().catch(() => undefined);
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
