export interface FirebaseAuthConfig {
  projectId: string;
  webApiKey: string;
  allowedUids: string[];
  lookupTimeoutMs: number;
}

export interface FirebasePrincipal {
  uid: string;
}

export type FirebaseAuthDecision =
  | { allowed: true; principal: FirebasePrincipal }
  | { allowed: false; status: 401 | 403 | 503; code: string };

interface FirebaseLookupUser {
  localId?: string;
  validSince?: string;
  disabled?: boolean;
}

interface FirebaseLookupResponse {
  users?: FirebaseLookupUser[];
}

interface FirebaseIdTokenPayload {
  aud?: unknown;
  iss?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  auth_time?: unknown;
}

function extractBearer(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return undefined;
  const match = header ? /^Bearer +(\S+)$/i.exec(header) : undefined;
  return match?.[1];
}

function decodePayload(token: string): FirebaseIdTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const value = JSON.parse(decoded) as unknown;
    return value && typeof value === "object" ? value as FirebaseIdTokenPayload : undefined;
  } catch {
    return undefined;
  }
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function claimsMatchProject(
  payload: FirebaseIdTokenPayload,
  user: FirebaseLookupUser,
  projectId: string,
  nowSeconds: number
): boolean {
  if (!user.localId || user.disabled === true) return false;
  if (payload.aud !== projectId) return false;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;
  if (payload.sub !== user.localId || typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) {
    return false;
  }
  if (!isFiniteInteger(payload.exp) || payload.exp <= nowSeconds) return false;
  if (!isFiniteInteger(payload.iat) || payload.iat > nowSeconds + 60) return false;
  if (!isFiniteInteger(payload.auth_time) || payload.auth_time > nowSeconds + 60) return false;

  const validSince = user.validSince === undefined ? 0 : Number(user.validSince);
  if (!Number.isFinite(validSince) || validSince < 0) return false;
  if (payload.iat < validSince) return false;
  return true;
}

export class FirebaseAuthVerifier {
  private readonly allowedUids: Set<string>;

  constructor(
    private readonly config: FirebaseAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.allowedUids = new Set(config.allowedUids);
  }

  async authorize(authorizationHeader: string | string[] | undefined): Promise<FirebaseAuthDecision> {
    const idToken = extractBearer(authorizationHeader);
    if (!idToken) return { allowed: false, status: 401, code: "invalid_token" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.lookupTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(this.config.webApiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken }),
          signal: controller.signal
        }
      );
    } catch {
      return { allowed: false, status: 503, code: "auth_unavailable" };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 500 || response.status === 429) {
      return { allowed: false, status: 503, code: "auth_unavailable" };
    }
    if (!response.ok) return { allowed: false, status: 401, code: "invalid_token" };

    let data: FirebaseLookupResponse;
    try {
      data = await response.json() as FirebaseLookupResponse;
    } catch {
      return { allowed: false, status: 503, code: "auth_unavailable" };
    }

    if (!Array.isArray(data.users) || data.users.length !== 1) {
      return { allowed: false, status: 401, code: "invalid_token" };
    }
    const user = data.users[0]!;
    const payload = decodePayload(idToken);
    if (!payload || !claimsMatchProject(payload, user, this.config.projectId, Math.floor(Date.now() / 1000))) {
      return { allowed: false, status: 401, code: "invalid_token" };
    }
    if (!this.allowedUids.has(user.localId!)) {
      return { allowed: false, status: 403, code: "principal_not_allowed" };
    }
    return { allowed: true, principal: { uid: user.localId! } };
  }
}
