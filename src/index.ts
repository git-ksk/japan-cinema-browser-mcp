#!/usr/bin/env node

import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer, config, probeBrowserReady, shutdownRuntime } from "./server.js";
import { hostAllowed, originAllowed, parseContentLength } from "./http-security.js";
import { FirebaseAuthVerifier } from "./firebase-auth.js";
import { runWithRequestPrincipal, type RequestPrincipal } from "./request-principal.js";

class HttpRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "HttpRequestError";
  }
}

function privateHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
}

function reject(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  privateHeaders(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

function validateProbeMethod(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  res.setHeader("allow", "GET, HEAD");
  reject(res, 405, "method_not_allowed");
  return false;
}

async function authorize(
  auth: FirebaseAuthVerifier,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RequestPrincipal | undefined> {
  const decision = await auth.authorize(req.headers.authorization);
  if (!decision.allowed) {
    if (decision.status === 401) {
      res.setHeader("www-authenticate", 'Bearer realm="japan-cinema-browser-mcp", error="invalid_token"');
    }
    reject(res, decision.status, decision.code);
    return undefined;
  }
  return { subject: `firebase:${decision.principal.uid}` };
}

async function readRequestBody(req: IncomingMessage): Promise<string | undefined> {
  try {
    parseContentLength(req.headers["content-length"], config.http.maxBodyBytes);
  } catch (error) {
    if (error instanceof Error && error.message === "request_body_too_large") {
      throw new HttpRequestError(413, "request_body_too_large");
    }
    throw new HttpRequestError(400, "invalid_content_length");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > config.http.maxBodyBytes) throw new HttpRequestError(413, "request_body_too_large");
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) rawValue.forEach((value) => headers.append(name, value));
    else headers.set(name, rawValue);
  }
  return headers;
}

async function toWebRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  return new Request(new URL(req.url ?? "/", `http://${host}`), {
    method: req.method ?? "POST",
    headers: toWebHeaders(req),
    body: await readRequestBody(req),
    signal
  });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  privateHeaders(res);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (value && !res.write(Buffer.from(value))) await once(res, "drain");
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  } finally {
    reader.releaseLock();
  }
}

function makeAbortController(req: IncomingMessage, res: ServerResponse): AbortController {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

async function startHttp(): Promise<void> {
  if (!config.auth) throw new Error("HTTP mode requires Firebase Auth configuration");
  const auth = new FirebaseAuthVerifier(config.auth);
  const mcpHandler = createMcpHandler(() => buildServer());
  const httpServer = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, config.http.allowedHosts)) {
      reject(res, 403, "host_not_allowed");
      return;
    }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/health") {
      if (!validateProbeMethod(req, res)) return;
      privateHeaders(res);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      return;
    }
    if (requestUrl.pathname === "/ready") {
      if (!validateProbeMethod(req, res)) return;
      void (async () => {
        const principal = await authorize(auth, req, res);
        if (!principal) return;
        await runWithRequestPrincipal(principal, async () => {
          try {
            await probeBrowserReady();
            privateHeaders(res);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true, browser: "ready" }));
          } catch {
            reject(res, 503, "browser_unavailable");
          }
        });
      })();
      return;
    }
    if (requestUrl.pathname !== "/mcp") {
      reject(res, 404, "not_found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      reject(res, 405, "method_not_allowed");
      return;
    }
    if (!originAllowed(req.headers.origin, config.http.allowedOrigins, config.http.allowedHosts)) {
      reject(res, 403, "origin_not_allowed");
      return;
    }
    const controller = makeAbortController(req, res);
    void (async () => {
      const principal = await authorize(auth, req, res);
      if (!principal) return;
      await runWithRequestPrincipal({ ...principal, operationScope: randomUUID() }, async () => {
        try {
          const request = await toWebRequest(req, controller.signal);
          const response = await mcpHandler.fetch(request);
          await writeWebResponse(response, res);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            if (error.status === 413) res.setHeader("connection", "close");
            reject(res, error.status, error.code);
            return;
          }
          if (!controller.signal.aborted) {
            console.error("[japan-cinema-browser-mcp] MCP HTTP error", {
              errorName: error instanceof Error ? error.name : "UnknownError"
            });
            reject(res, 500, "mcp_handler_error");
          }
        }
      });
    })();
  });

  httpServer.maxHeadersCount = 64;
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = Math.max(40_000, config.policy.operationTimeoutMs + 5_000);
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(config.http.port, config.http.host, () => resolve());
  });
  console.error(`[japan-cinema-browser-mcp] Streamable HTTP listening on http://${config.http.host}:${config.http.port}/mcp`);
  console.error(`[japan-cinema-browser-mcp] Remote mode: ${config.remote.enabled ? "enabled" : "disabled"}`);
  console.error(`[japan-cinema-browser-mcp] MCP usage control: ${config.usage ? "firestore" : "disabled"}`);

  const shutdown = async () => {
    await mcpHandler.close().catch(() => undefined);
    await shutdownRuntime().catch(() => undefined);
    httpServer.closeIdleConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

async function startStdio(): Promise<void> {
  const handle = serveStdio(() => buildServer());
  console.error("[japan-cinema-browser-mcp] listening on stdio");
  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    await shutdownRuntime().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

if (process.argv.includes("--http")) await startHttp();
else await startStdio();
