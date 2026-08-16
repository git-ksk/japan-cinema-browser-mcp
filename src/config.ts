import os from "node:os";
import path from "node:path";

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeHostname(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  normalized = normalized.replace(/\.$/, "");
  if (!normalized || normalized.includes("/") || normalized.includes("://")) {
    throw new Error(`Invalid hostname in MCP_ALLOWED_HOSTS: ${value}`);
  }
  return normalized;
}

function envHosts(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  return [...new Set((raw ? raw.split(",") : fallback).map(normalizeHostname).filter(Boolean))];
}

function envOrigins(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return [...new Set(raw.split(",").map((value) => {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${name} entries must use http or https origins`);
    }
    return url.origin;
  }))];
}

function isLoopback(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export interface AppConfig {
  browser: {
    executable?: string;
    profileDir: string;
    externalCdpPort?: number;
    allowExternalCdp: boolean;
    headless: boolean;
    allowUnsandboxedChromium: boolean;
  };
  http: {
    host: string;
    port: number;
    allowedHosts: string[];
    allowedOrigins: string[];
    maxBodyBytes: number;
  };
  auth?: {
    projectId: string;
    webApiKey: string;
    allowedUids: string[];
    lookupTimeoutMs: number;
  };
  remote: {
    enabled: boolean;
    disableHumanHandoff: boolean;
  };
  usage?: {
    projectId: string;
    dailyLimit: number;
    leaseTtlMs: number;
  };
  policy: {
    maxReadChars: number;
    confirmationTtlMs: number;
    enablePurchase: boolean;
    operationTimeoutMs: number;
  };
}

export function loadConfig(): AppConfig {
  const allowExternalCdp = envBool("CINEMA_ALLOW_EXTERNAL_CDP", false);
  const externalCdpPort = process.env.CINEMA_CDP_PORT
    ? envInt("CINEMA_CDP_PORT", 9222, 1, 65535)
    : undefined;
  if (externalCdpPort !== undefined && !allowExternalCdp) {
    throw new Error(
      "CINEMA_CDP_PORT requires CINEMA_ALLOW_EXTERNAL_CDP=true because attaching to an existing Chrome session weakens profile isolation"
    );
  }

  const headless = envBool("CINEMA_HEADLESS", false);
  const remoteEnabled = envBool("CINEMA_REMOTE_MODE", false);
  const enablePurchase = envBool("CINEMA_ENABLE_PURCHASE", false);
  const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const allowNonLoopback = envBool("MCP_ALLOW_NONLOOPBACK", false);
  const firebaseProjectId = process.env.MCP_FIREBASE_PROJECT_ID?.trim() || undefined;
  const firebaseWebApiKey = process.env.MCP_FIREBASE_WEB_API_KEY?.trim() || undefined;
  const allowedFirebaseUids = [...new Set((process.env.MCP_ALLOWED_FIREBASE_UIDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))];
  const authConfigured = Boolean(firebaseProjectId && firebaseWebApiKey && allowedFirebaseUids.length > 0);
  if (!isLoopback(host) && !allowNonLoopback) {
    throw new Error("Non-loopback MCP_HTTP_HOST requires MCP_ALLOW_NONLOOPBACK=true");
  }
  if (remoteEnabled) {
    if (!headless) throw new Error("CINEMA_REMOTE_MODE=true requires CINEMA_HEADLESS=true");
    if (externalCdpPort !== undefined) throw new Error("CINEMA_REMOTE_MODE=true forbids external CDP attachment");
    if (enablePurchase) throw new Error("CINEMA_REMOTE_MODE=true requires CINEMA_ENABLE_PURCHASE=false");
    if (!firebaseProjectId) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_FIREBASE_PROJECT_ID");
    if (!firebaseWebApiKey) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_FIREBASE_WEB_API_KEY");
    if (allowedFirebaseUids.length === 0) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_ALLOWED_FIREBASE_UIDS");
  }

  const usageRequired = envBool("MCP_USAGE_REQUIRED", false);
  const usageProjectId = process.env.MCP_USAGE_FIRESTORE_PROJECT_ID?.trim() || undefined;
  if (usageRequired && !usageProjectId) {
    throw new Error("MCP_USAGE_FIRESTORE_PROJECT_ID is required when MCP_USAGE_REQUIRED=true");
  }
  if (usageProjectId && !remoteEnabled) {
    throw new Error("Firestore MCP usage control currently requires CINEMA_REMOTE_MODE=true so local multi-round handoff semantics remain unchanged");
  }

  const httpPort = process.env.MCP_HTTP_PORT === undefined
    ? envInt("PORT", 8787, 1, 65535)
    : envInt("MCP_HTTP_PORT", 8787, 1, 65535);

  return {
    browser: {
      executable: process.env.CINEMA_CHROME_EXECUTABLE || undefined,
      profileDir: process.env.CINEMA_CHROME_PROFILE_DIR ?? path.join(os.homedir(), ".japan-cinema-browser-mcp", "chrome-profile"),
      externalCdpPort,
      allowExternalCdp,
      headless,
      allowUnsandboxedChromium: envBool("CINEMA_ALLOW_UNSANDBOXED_CHROMIUM", false)
    },
    http: {
      host,
      port: httpPort,
      allowedHosts: envHosts("MCP_ALLOWED_HOSTS", ["localhost", "127.0.0.1", "::1"]),
      allowedOrigins: envOrigins("MCP_ALLOWED_ORIGINS"),
      maxBodyBytes: envInt("MCP_MAX_BODY_BYTES", 262_144, 1_024, 4_194_304)
    },
    ...(authConfigured ? {
      auth: {
        projectId: firebaseProjectId!,
        webApiKey: firebaseWebApiKey!,
        allowedUids: allowedFirebaseUids,
        lookupTimeoutMs: envInt("MCP_FIREBASE_LOOKUP_TIMEOUT_MS", 5_000, 1_000, 15_000)
      }
    } : {}),
    remote: {
      enabled: remoteEnabled,
      disableHumanHandoff: remoteEnabled
    },
    ...(usageProjectId ? {
      usage: {
        projectId: usageProjectId,
        dailyLimit: envInt("MCP_USAGE_DAILY_LIMIT", 100, 1, 10_000),
        leaseTtlMs: envInt("MCP_USAGE_LEASE_TTL_MS", 60_000, 10_000, 600_000)
      }
    } : {}),
    policy: {
      maxReadChars: envInt("CINEMA_MAX_READ_CHARS", 8_000, 500, 30_000),
      confirmationTtlMs: envInt("CINEMA_CONFIRMATION_TTL_SECONDS", 120, 30, 600) * 1_000,
      enablePurchase,
      operationTimeoutMs: envInt("CINEMA_OPERATION_TIMEOUT_MS", 30_000, 5_000, 120_000)
    }
  };
}
