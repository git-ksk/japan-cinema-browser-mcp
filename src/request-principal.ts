import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface RequestPrincipal {
  subject: string;
}

const principalContext = new AsyncLocalStorage<RequestPrincipal>();

export function runWithRequestPrincipal<T>(principal: RequestPrincipal, callback: () => T): T {
  return principalContext.run(principal, callback);
}

export function currentRequestPrincipal(): RequestPrincipal | undefined {
  return principalContext.getStore();
}

export function principalBinding(principal: RequestPrincipal): string {
  return createHash("sha256")
    .update("japan-cinema-browser-mcp/principal/v1\0")
    .update(principal.subject)
    .digest("base64url");
}
