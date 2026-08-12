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

export interface AppConfig {
  browser: {
    executable?: string;
    profileDir: string;
    externalCdpPort?: number;
    allowExternalCdp: boolean;
    headless: boolean;
  };
  policy: {
    maxReadChars: number;
    confirmationTtlMs: number;
    enablePurchase: boolean;
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

  return {
    browser: {
      executable: process.env.CINEMA_CHROME_EXECUTABLE || undefined,
      profileDir:
        process.env.CINEMA_CHROME_PROFILE_DIR ??
        path.join(os.homedir(), ".japan-cinema-browser-mcp", "chrome-profile"),
      externalCdpPort,
      allowExternalCdp,
      headless: envBool("CINEMA_HEADLESS", false)
    },
    policy: {
      maxReadChars: envInt("CINEMA_MAX_READ_CHARS", 8_000, 500, 30_000),
      confirmationTtlMs: envInt("CINEMA_CONFIRMATION_TTL_SECONDS", 120, 30, 600) * 1_000,
      enablePurchase: envBool("CINEMA_ENABLE_PURCHASE", false)
    }
  };
}
