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

function publicOrigin(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${name} must not include a path`);
  }
  return url.origin;
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
  oauth?: {
    publicBaseUrl: string;
    firestoreProjectId: string;
    allowedClientHosts: string[];
    authorizationRequestTtlMs: number;
    authorizationCodeTtlMs: number;
    accessTokenTtlMs: number;
    refreshTokenTtlMs: number;
    clientMetadataTimeoutMs: number;
  };
  remote: {
    enabled: boolean;
    disableHumanHandoff: boolean;
  };
  takeover: {
    enabled: boolean;
    publicBaseUrl?: string;
    ttlMs: number;
    cloudflareAccessEmail?: string;
    webRtcRuntime?: {
      hostExecutable: string;
      displayId?: number;
      displayName?: string;
    };
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
  const takeoverEnabled = envBool("CINEMA_REMOTE_TAKEOVER", false);
  const takeoverPublicBaseUrl = publicOrigin("CINEMA_TAKEOVER_PUBLIC_BASE_URL");
  const takeoverAccessEmailRaw = process.env.CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL?.trim().toLowerCase();
  const takeoverAccessEmail = takeoverAccessEmailRaw || undefined;
  const takeoverHostExecutable = process.env.CINEMA_WEBRTC_TAKEOVER_HOST_EXECUTABLE?.trim() || undefined;
  const takeoverDisplayId = process.env.CINEMA_WEBRTC_TAKEOVER_DISPLAY_ID
    ? envInt("CINEMA_WEBRTC_TAKEOVER_DISPLAY_ID", 1, 1, 4_294_967_295)
    : undefined;
  const takeoverDisplayName = process.env.CINEMA_WEBRTC_TAKEOVER_DISPLAY_NAME?.trim() || undefined;
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
  const publicBaseUrl = publicOrigin("MCP_PUBLIC_BASE_URL");
  const oauthAllowedClientHosts = envHosts("MCP_OAUTH_ALLOWED_CLIENT_HOSTS", []);
  if (!isLoopback(host) && !allowNonLoopback) {
    throw new Error("Non-loopback MCP_HTTP_HOST requires MCP_ALLOW_NONLOOPBACK=true");
  }
  if (takeoverAccessEmail && (!/^[^@\s]{1,128}@[^@\s]{1,190}$/.test(takeoverAccessEmail) || takeoverAccessEmail.length > 320)) {
    throw new Error("CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL must be one valid email address");
  }
  if (takeoverEnabled) {
    if (!isLoopback(host)) throw new Error("CINEMA_REMOTE_TAKEOVER=true requires loopback MCP_HTTP_HOST behind an authenticated HTTPS gateway");
    if (headless) throw new Error("CINEMA_REMOTE_TAKEOVER=true requires headed Chrome because Browser Handoff binds one visible OS window");
    if (externalCdpPort !== undefined) throw new Error("CINEMA_REMOTE_TAKEOVER=true forbids external CDP attachment");
    if (!takeoverPublicBaseUrl) throw new Error("CINEMA_REMOTE_TAKEOVER=true requires CINEMA_TAKEOVER_PUBLIC_BASE_URL");
    if (!takeoverAccessEmail) throw new Error("CINEMA_REMOTE_TAKEOVER=true requires CINEMA_TAKEOVER_CLOUDFLARE_ACCESS_EMAIL");
    if (!takeoverHostExecutable || takeoverHostExecutable.includes("\0") || !path.isAbsolute(takeoverHostExecutable)) {
      throw new Error("CINEMA_REMOTE_TAKEOVER=true requires absolute CINEMA_WEBRTC_TAKEOVER_HOST_EXECUTABLE");
    }
    if (process.platform === "darwin") {
      if (takeoverDisplayName) throw new Error("CINEMA_WEBRTC_TAKEOVER_DISPLAY_NAME is Linux-only");
    } else if (process.platform === "linux") {
      if (takeoverDisplayId !== undefined) throw new Error("CINEMA_WEBRTC_TAKEOVER_DISPLAY_ID is macOS-only");
      if (takeoverDisplayName && !/^:\d+(?:\.\d+)?$/.test(takeoverDisplayName)) {
        throw new Error("CINEMA_WEBRTC_TAKEOVER_DISPLAY_NAME must be a local X11 display such as :99");
      }
    } else {
      throw new Error("CINEMA_REMOTE_TAKEOVER=true currently supports macOS or Linux Browser Handoff hosts only");
    }
    if (authConfigured && allowedFirebaseUids.length !== 1) {
      throw new Error("CINEMA_REMOTE_TAKEOVER=true currently requires exactly one allowed Firebase uid");
    }
  }
  if (remoteEnabled) {
    if (!headless) throw new Error("CINEMA_REMOTE_MODE=true requires CINEMA_HEADLESS=true");
    if (externalCdpPort !== undefined) throw new Error("CINEMA_REMOTE_MODE=true forbids external CDP attachment");
    if (enablePurchase) throw new Error("CINEMA_REMOTE_MODE=true requires CINEMA_ENABLE_PURCHASE=false");
    if (!firebaseProjectId) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_FIREBASE_PROJECT_ID");
    if (!firebaseWebApiKey) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_FIREBASE_WEB_API_KEY");
    if (allowedFirebaseUids.length === 0) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_ALLOWED_FIREBASE_UIDS");
    if (!publicBaseUrl) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_PUBLIC_BASE_URL");
    if (oauthAllowedClientHosts.length === 0) throw new Error("CINEMA_REMOTE_MODE=true requires MCP_OAUTH_ALLOWED_CLIENT_HOSTS");
    const publicHost = new URL(publicBaseUrl).hostname;
    if (!envHosts("MCP_ALLOWED_HOSTS", ["localhost", "127.0.0.1", "::1"]).includes(publicHost)) {
      throw new Error("MCP_PUBLIC_BASE_URL hostname must be present in MCP_ALLOWED_HOSTS");
    }
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
    ...(authConfigured && publicBaseUrl && oauthAllowedClientHosts.length > 0 ? {
      oauth: {
        publicBaseUrl,
        firestoreProjectId: firebaseProjectId!,
        allowedClientHosts: oauthAllowedClientHosts,
        authorizationRequestTtlMs: envInt("MCP_OAUTH_AUTHORIZATION_TTL_SECONDS", 600, 60, 1800) * 1_000,
        authorizationCodeTtlMs: envInt("MCP_OAUTH_CODE_TTL_SECONDS", 120, 30, 600) * 1_000,
        accessTokenTtlMs: envInt("MCP_OAUTH_ACCESS_TTL_SECONDS", 3600, 300, 86400) * 1_000,
        refreshTokenTtlMs: envInt("MCP_OAUTH_REFRESH_TTL_DAYS", 30, 1, 90) * 86_400_000,
        clientMetadataTimeoutMs: envInt("MCP_OAUTH_CLIENT_METADATA_TIMEOUT_MS", 5_000, 1_000, 15_000)
      }
    } : {}),
    remote: {
      enabled: remoteEnabled,
      disableHumanHandoff: remoteEnabled && !takeoverEnabled
    },
    takeover: {
      enabled: takeoverEnabled,
      ...(takeoverPublicBaseUrl ? { publicBaseUrl: takeoverPublicBaseUrl } : {}),
      ttlMs: envInt("CINEMA_TAKEOVER_TTL_SECONDS", 300, 60, 600) * 1_000,
      ...(takeoverAccessEmail ? { cloudflareAccessEmail: takeoverAccessEmail } : {}),
      ...(takeoverEnabled && takeoverHostExecutable ? {
        webRtcRuntime: {
          hostExecutable: takeoverHostExecutable,
          ...(takeoverDisplayId !== undefined ? { displayId: takeoverDisplayId } : {}),
          ...(takeoverDisplayName ? { displayName: takeoverDisplayName } : {})
        }
      } : {})
    },
    policy: {
      maxReadChars: envInt("CINEMA_MAX_READ_CHARS", 8_000, 500, 30_000),
      confirmationTtlMs: envInt("CINEMA_CONFIRMATION_TTL_SECONDS", 120, 30, 600) * 1_000,
      enablePurchase,
      operationTimeoutMs: envInt("CINEMA_OPERATION_TIMEOUT_MS", 30_000, 5_000, 120_000)
    }
  };
}
