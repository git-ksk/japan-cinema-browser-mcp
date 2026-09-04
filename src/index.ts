#!/usr/bin/env node

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
  type AuthInfo
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  buildServer,
  config,
  handleTakeoverHttpRequest,
  handleTakeoverUpgrade,
  isTakeoverHttpPath,
  probeBrowserReady,
  shutdownRuntime
} from "./server.js";
import { hostAllowed, originAllowed, parseContentLength } from "./http-security.js";
import { FirebaseAuthVerifier } from "./firebase-auth.js";
import { CinemaOAuthServer, cinemaOAuthResourceScope } from "./oauth-server.js";
import { FirestoreCinemaOAuthStore } from "./oauth-store.js";
import { runWithRequestPrincipal, type RequestPrincipal } from "./request-principal.js";
import { cloudflareAccessTakeoverPrincipalBinding } from "./takeover-access.js";

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
  oauth: CinemaOAuthServer,
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ principal: RequestPrincipal; authInfo: AuthInfo } | undefined> {
  const authorization = Array.isArray(req.headers.authorization) ? undefined : req.headers.authorization;
  let authInfo: AuthInfo;
  try {
    authInfo = await verifyBearerToken(authorization, {
      verifier: oauth.accessTokenVerifier,
      requiredScopes: [cinemaOAuthResourceScope],
      resourceMetadataUrl: oauth.resourceMetadataUrl
    });
  } catch (error) {
    await writeWebResponse(bearerAuthChallengeResponse(error, {
      requiredScopes: [cinemaOAuthResourceScope],
      resourceMetadataUrl: oauth.resourceMetadataUrl
    }), res);
    return undefined;
  }
  const uid = authInfo.extra?.uid;
  if (typeof uid !== "string" || uid.length === 0) {
    reject(res, 500, "auth_context_invalid");
    return undefined;
  }
  return { principal: { subject: `firebase:${uid}` }, authInfo };
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

async function startTakeoverIngress(): Promise<Server | undefined> {
  if (!config.takeover.enabled) return undefined;
  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, ["localhost", "127.0.0.1", "::1"])) {
      reject(res, 403, "host_not_allowed");
      return;
    }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (!isTakeoverHttpPath(requestUrl.pathname)) {
      reject(res, 404, "not_found");
      return;
    }
    const boundPrincipal = cloudflareAccessTakeoverPrincipalBinding(req.headers, config.takeover);
    if (!boundPrincipal) {
      reject(res, 403, "takeover_access_denied");
      return;
    }
    const controller = makeAbortController(req, res);
    void (async () => {
      try {
        const request = await toWebRequest(req, controller.signal);
        const response = await handleTakeoverHttpRequest(request, boundPrincipal);
        await writeWebResponse(response, res);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[japan-cinema-browser-mcp] WSS takeover HTTP error", {
            errorName: error instanceof Error ? error.name : "UnknownError"
          });
          reject(res, 500, "takeover_handler_error");
        }
      }
    })();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req.headers.host, ["localhost", "127.0.0.1", "::1"])) { socket.destroy(); return; }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (!isTakeoverHttpPath(requestUrl.pathname)) { socket.destroy(); return; }
    const boundPrincipal = cloudflareAccessTakeoverPrincipalBinding(req.headers, config.takeover);
    if (!boundPrincipal || !handleTakeoverUpgrade(req, socket, head)) socket.destroy();
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(config.takeover.localPort, "127.0.0.1", () => resolve());
  });
  console.error(`[japan-cinema-browser-mcp] WSS Human takeover listening on http://127.0.0.1:${config.takeover.localPort}`);
  return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startHttp(): Promise<void> {
  if (!config.auth || !config.oauth) throw new Error("HTTP mode requires Firebase Auth and MCP OAuth configuration");
  const takeoverIngress = await startTakeoverIngress();
  const firebaseAuth = new FirebaseAuthVerifier(config.auth);
  const { firestoreProjectId, ...oauthRuntimeConfig } = config.oauth;
  const oauthStore = new FirestoreCinemaOAuthStore(firestoreProjectId);
  const oauth = new CinemaOAuthServer({
    ...oauthRuntimeConfig,
    firebaseWebApiKey: config.auth.webApiKey,
    allowedFirebaseUids: config.auth.allowedUids
  }, oauthStore, firebaseAuth);
  const mcpHandler = createMcpHandler(() => buildServer());
  const httpServer = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, config.http.allowedHosts)) {
      reject(res, 403, "host_not_allowed");
      return;
    }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (oauth.isPath(requestUrl.pathname)) {
      const controller = makeAbortController(req, res);
      void (async () => {
        try {
          const request = await toWebRequest(req, controller.signal);
          const response = await oauth.handle(request);
          await writeWebResponse(response, res);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            reject(res, error.status, error.code);
            return;
          }
          if (!controller.signal.aborted) {
            console.error("[japan-cinema-browser-mcp] OAuth HTTP error", {
              errorName: error instanceof Error ? error.name : "UnknownError"
            });
            reject(res, 500, "oauth_handler_error");
          }
        }
      })();
      return;
    }
    if (isTakeoverHttpPath(requestUrl.pathname)) {
      const boundPrincipal = cloudflareAccessTakeoverPrincipalBinding(req.headers, config.takeover);
      if (!boundPrincipal) {
        reject(res, 403, "takeover_access_denied");
        return;
      }
      const controller = makeAbortController(req, res);
      void (async () => {
        try {
          const request = await toWebRequest(req, controller.signal);
          const response = await handleTakeoverHttpRequest(request, boundPrincipal);
          await writeWebResponse(response, res);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            if (error.status === 413) res.setHeader("connection", "close");
            reject(res, error.status, error.code);
            return;
          }
          if (!controller.signal.aborted) {
            console.error("[japan-cinema-browser-mcp] takeover broker HTTP error", {
              errorName: error instanceof Error ? error.name : "UnknownError"
            });
            reject(res, 500, "takeover_broker_error");
          }
        }
      })();
      return;
    }
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
        const authorized = await authorize(oauth, req, res);
        if (!authorized) return;
        await runWithRequestPrincipal(authorized.principal, async () => {
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
      const authorized = await authorize(oauth, req, res);
      if (!authorized) return;
      await runWithRequestPrincipal(authorized.principal, async () => {
        try {
          const request = await toWebRequest(req, controller.signal);
          const response = await mcpHandler.fetch(request, { authInfo: authorized.authInfo });
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
  // find_showtimes may isolate up to three provider reads sequentially. Keep the
  // HTTP envelope larger than that bounded aggregate (plus cold Chromium and
  // auth overhead) so the transport cannot cancel a structured partial result
  // before the tool boundary returns it.
  httpServer.requestTimeout = Math.max(
    40_000,
    Math.min(420_000, config.policy.operationTimeoutMs * 3 + 60_000)
  );
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(config.http.port, config.http.host, () => resolve());
  });
  console.error(`[japan-cinema-browser-mcp] Streamable HTTP listening on http://${config.http.host}:${config.http.port}/mcp`);
  console.error(`[japan-cinema-browser-mcp] Remote mode: ${config.remote.enabled ? "enabled" : "disabled"}`);
  console.error("[japan-cinema-browser-mcp] Remote authentication: OAuth 2.1 + Firebase Auth");
  console.error(`[japan-cinema-browser-mcp] Remote Human takeover: ${config.takeover.enabled ? "enabled via Cloudflare Access" : "disabled"}`);

  const shutdown = async () => {
    await mcpHandler.close().catch(() => undefined);
    await oauth.close().catch(() => undefined);
    await shutdownRuntime().catch(() => undefined);
    await closeServer(takeoverIngress).catch(() => undefined);
    httpServer.closeIdleConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

async function startStdio(): Promise<void> {
  const takeoverIngress = await startTakeoverIngress();
  const handle = serveStdio(() => buildServer());
  console.error("[japan-cinema-browser-mcp] listening on stdio");
  const shutdown = async () => {
    await handle.close().catch(() => undefined);
    await shutdownRuntime().catch(() => undefined);
    await closeServer(takeoverIngress).catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

if (process.argv.includes("--http")) await startHttp();
else await startStdio();
