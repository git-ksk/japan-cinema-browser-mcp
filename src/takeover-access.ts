import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export interface CinemaTakeoverAccessConfig {
  enabled: boolean;
  cloudflareAccessEmail?: string;
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value?.trim();
}

export function takeoverPrincipalBindingForEmail(email: string): string {
  return createHash("sha256")
    .update("japan-cinema-browser-mcp/takeover-principal/v1\0")
    .update(email.trim().toLowerCase())
    .digest("base64url");
}

/**
 * Cloudflare Access is the authenticated Human gateway for the browser takeover URL.
 * This trust mode is valid only when the HTTP listener is loopback-only and reached
 * through a Cloudflare Tunnel protected by Access. The tunnel is the verification
 * boundary for Cf-Access-* headers; direct public origin exposure is not supported.
 */
export function cloudflareAccessTakeoverPrincipalBinding(
  headers: IncomingHttpHeaders,
  config: CinemaTakeoverAccessConfig
): string | undefined {
  if (!config.enabled || !config.cloudflareAccessEmail) return undefined;
  const email = oneHeader(headers["cf-access-authenticated-user-email"])?.toLowerCase();
  const assertion = oneHeader(headers["cf-access-jwt-assertion"]);
  if (!email || !assertion || assertion.split(".").length !== 3) return undefined;
  if (email !== config.cloudflareAccessEmail.toLowerCase()) return undefined;
  return takeoverPrincipalBindingForEmail(email);
}
