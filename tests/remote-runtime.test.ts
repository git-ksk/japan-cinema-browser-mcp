import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { bearerAllowed, hostAllowed, originAllowed, parseContentLength } from "../src/http-security.js";

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

const token = "x".repeat(64);

test("remote mode is bounded, authenticated, headless, purchase-disabled and usage-aware", () => {
  withEnv({
    CINEMA_REMOTE_MODE: "true",
    CINEMA_HEADLESS: "true",
    CINEMA_ENABLE_PURCHASE: "false",
    MCP_HTTP_HOST: "0.0.0.0",
    MCP_ALLOW_NONLOOPBACK: "true",
    MCP_BEARER_TOKEN: token,
    MCP_USAGE_REQUIRED: "true",
    MCP_USAGE_FIRESTORE_PROJECT_ID: "mcp-runtime-ksk",
    MCP_USAGE_DAILY_LIMIT: "100",
    CINEMA_OPERATION_TIMEOUT_MS: "30000"
  }, () => {
    const config = loadConfig();
    assert.equal(config.remote.enabled, true);
    assert.equal(config.remote.disableHumanHandoff, true);
    assert.equal(config.browser.headless, true);
    assert.equal(config.policy.enablePurchase, false);
    assert.equal(config.policy.operationTimeoutMs, 30_000);
    assert.equal(config.usage?.dailyLimit, 100);
    assert.equal(config.usage?.projectId, "mcp-runtime-ksk");
  });
});

test("remote mode fails closed without required isolation and authentication settings", () => {
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "false", MCP_BEARER_TOKEN: token }, () => {
    assert.throws(() => loadConfig(), /requires CINEMA_HEADLESS=true/);
  });
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "true", MCP_BEARER_TOKEN: undefined }, () => {
    assert.throws(() => loadConfig(), /requires MCP_BEARER_TOKEN/);
  });
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "true", CINEMA_ENABLE_PURCHASE: "true", MCP_BEARER_TOKEN: token }, () => {
    assert.throws(() => loadConfig(), /requires CINEMA_ENABLE_PURCHASE=false/);
  });
});

test("Firestore usage control cannot silently attach to local handoff mode", () => {
  withEnv({ CINEMA_REMOTE_MODE: "false", MCP_USAGE_FIRESTORE_PROJECT_ID: "mcp-runtime-ksk" }, () => {
    assert.throws(() => loadConfig(), /requires CINEMA_REMOTE_MODE=true/);
  });
  withEnv({ CINEMA_REMOTE_MODE: "true", CINEMA_HEADLESS: "true", MCP_BEARER_TOKEN: token, MCP_USAGE_REQUIRED: "true", MCP_USAGE_FIRESTORE_PROJECT_ID: undefined }, () => {
    assert.throws(() => loadConfig(), /MCP_USAGE_FIRESTORE_PROJECT_ID is required/);
  });
});

test("HTTP boundary validates exact hosts, origins, bearer and bounded content length", () => {
  assert.equal(hostAllowed("cinema.example:443", ["cinema.example"]), true);
  assert.equal(hostAllowed("evil.example", ["cinema.example"]), false);
  assert.equal(originAllowed("https://cinema.example", [], ["cinema.example"]), true);
  assert.equal(originAllowed("https://evil.example", [], ["cinema.example"]), false);
  assert.equal(bearerAllowed(`Bearer ${token}`, token), true);
  assert.equal(bearerAllowed("Bearer wrong", token), false);
  assert.equal(parseContentLength("1024", 2048), 1024);
  assert.throws(() => parseContentLength("2049", 2048), /request_body_too_large/);
  assert.throws(() => parseContentLength("1.5", 2048), /invalid_content_length/);
});
