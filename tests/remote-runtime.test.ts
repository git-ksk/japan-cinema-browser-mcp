import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { hostAllowed, originAllowed, parseContentLength } from "../src/http-security.js";

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const before = { ...process.env };
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    process.env = before;
  }
}

test("remote mode is bounded, authenticated, headless, and purchase-disabled", () => {
  withEnv({
    CINEMA_REMOTE_MODE: "true",
    CINEMA_HEADLESS: "true",
    CINEMA_ENABLE_PURCHASE: "false",
    MCP_HTTP_HOST: "0.0.0.0",
    MCP_ALLOW_NONLOOPBACK: "true",
    MCP_ALLOWED_HOSTS: "cinema.example",
    MCP_PUBLIC_BASE_URL: "https://cinema.example",
    MCP_OAUTH_ALLOWED_CLIENT_HOSTS: "chatgpt.com",
    MCP_FIREBASE_PROJECT_ID: "test-mcp-runtime",
    MCP_FIREBASE_WEB_API_KEY: "public-web-api-key",
    MCP_ALLOWED_FIREBASE_UIDS: "owner-uid",
    CINEMA_OPERATION_TIMEOUT_MS: "30000"
  }, () => {
    const config = loadConfig();
    assert.equal(config.remote.enabled, true);
    assert.equal(config.remote.disableHumanHandoff, true);
    assert.equal(config.browser.headless, true);
    assert.equal(config.policy.enablePurchase, false);
    assert.equal(config.policy.operationTimeoutMs, 30_000);
    assert.equal(config.oauth?.publicBaseUrl, "https://cinema.example");
    assert.deepEqual(config.oauth?.allowedClientHosts, ["chatgpt.com"]);
    assert.equal(config.oauth?.accessTokenTtlMs, 3_600_000);
  });
});

test("remote mode fails closed without required isolation and authentication settings", () => {
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "false", MCP_FIREBASE_PROJECT_ID: "p", MCP_FIREBASE_WEB_API_KEY: "k", MCP_ALLOWED_FIREBASE_UIDS: "u" }, () => {
    assert.throws(() => loadConfig(), /requires CINEMA_HEADLESS=true/);
  });
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "true", MCP_FIREBASE_PROJECT_ID: undefined, MCP_FIREBASE_WEB_API_KEY: "k", MCP_ALLOWED_FIREBASE_UIDS: "u" }, () => {
    assert.throws(() => loadConfig(), /requires MCP_FIREBASE_PROJECT_ID/);
  });
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "true", CINEMA_ENABLE_PURCHASE: "true", MCP_FIREBASE_PROJECT_ID: "p", MCP_FIREBASE_WEB_API_KEY: "k", MCP_ALLOWED_FIREBASE_UIDS: "u" }, () => {
    assert.throws(() => loadConfig(), /requires CINEMA_ENABLE_PURCHASE=false/);
  });
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "true", MCP_FIREBASE_PROJECT_ID: "p", MCP_FIREBASE_WEB_API_KEY: "k", MCP_ALLOWED_FIREBASE_UIDS: "u", MCP_PUBLIC_BASE_URL: undefined }, () => {
    assert.throws(() => loadConfig(), /requires MCP_PUBLIC_BASE_URL/);
  });
});

test("HTTP boundary validates exact hosts, origins, and bounded content length", () => {
  assert.equal(hostAllowed("cinema.example:443", ["cinema.example"]), true);
  assert.equal(hostAllowed("evil.example", ["cinema.example"]), false);
  assert.equal(originAllowed("https://cinema.example", [], ["cinema.example"]), true);
  assert.equal(originAllowed("https://evil.example", [], ["cinema.example"]), false);
  assert.equal(parseContentLength("1024", 2048), 1024);
  assert.throws(() => parseContentLength("2049", 2048), /request_body_too_large/);
  assert.throws(() => parseContentLength("1.5", 2048), /invalid_content_length/);
});


test("standalone remote takeover is opt-in, loopback-only, and Cloudflare-Access bound", () => {
  withEnv({
    CINEMA_REMOTE_TAKEOVER: "true",
    CINEMA_TAKEOVER_PUBLIC_BASE_URL: "https://cinema-handoff.example",
    CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL: "owner@example.com",
    CINEMA_TAKEOVER_HOST_EXECUTABLE: "/tmp/handoff-window-host",
    MCP_HTTP_HOST: "127.0.0.1",
    CINEMA_ALLOW_EXTERNAL_CDP: "false",
    CINEMA_CDP_PORT: undefined
  }, () => {
    if (process.platform !== "darwin") {
      assert.throws(() => loadConfig(), /reviewed macOS exact-Window WSS path only/);
      return;
    }
    const config = loadConfig();
    assert.equal(config.takeover.enabled, true);
    assert.equal(config.takeover.publicBaseUrl, "https://cinema-handoff.example");
    assert.equal(config.takeover.cloudflareAccessEmail, "owner@example.com");
    assert.equal(config.takeover.localPort, 48_561);
    assert.equal(config.takeover.hostExecutable, "/tmp/handoff-window-host");
    assert.equal(config.remote.disableHumanHandoff, false);
  });

  withEnv({
    CINEMA_REMOTE_TAKEOVER: "true",
    CINEMA_TAKEOVER_PUBLIC_BASE_URL: "https://cinema-handoff.example",
    CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL: "owner@example.com",
    CINEMA_TAKEOVER_HOST_EXECUTABLE: "/tmp/handoff-window-host",
    MCP_HTTP_HOST: "0.0.0.0",
    MCP_ALLOW_NONLOOPBACK: "true"
  }, () => {
    assert.throws(() => loadConfig(), /requires loopback MCP_HTTP_HOST/);
  });

  withEnv({
    CINEMA_REMOTE_TAKEOVER: "true",
    CINEMA_TAKEOVER_PUBLIC_BASE_URL: "https://cinema-handoff.example",
    CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL: "owner@example.com",
    CINEMA_TAKEOVER_HOST_EXECUTABLE: "/tmp/handoff-window-host",
    CINEMA_HEADLESS: "true",
    MCP_HTTP_HOST: "127.0.0.1"
  }, () => {
    assert.throws(() => loadConfig(), /requires headed Chrome/);
  });

  withEnv({
    CINEMA_REMOTE_TAKEOVER: "true",
    CINEMA_TAKEOVER_PUBLIC_BASE_URL: "https://cinema-handoff.example",
    CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL: "owner@example.com",
    CINEMA_TAKEOVER_HOST_EXECUTABLE: undefined,
    MCP_HTTP_HOST: "127.0.0.1"
  }, () => {
    assert.throws(() => loadConfig(), /requires absolute CINEMA_TAKEOVER_HOST_EXECUTABLE/);
  });

  withEnv({ CINEMA_REMOTE_TAKEOVER: "true", MCP_HTTP_HOST: "127.0.0.1" }, () => {
    assert.throws(() => loadConfig(), /requires CINEMA_TAKEOVER_PUBLIC_BASE_URL/);
  });
});
