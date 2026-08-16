import { createHash, randomBytes } from "node:crypto";
import { Firestore, type DocumentData } from "@google-cloud/firestore";

export interface OAuthAuthorizationRequestRecord {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface OAuthAuthorizationCodeRecord {
  uid: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface OAuthTokenRecord {
  uid: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface IssuedOAuthTokens {
  accessToken: string;
  refreshToken: string;
  access: OAuthTokenRecord;
  refresh: OAuthTokenRecord;
}

export interface CinemaOAuthStore {
  createAuthorizationRequest(record: OAuthAuthorizationRequestRecord): Promise<string>;
  getAuthorizationRequest(handle: string): Promise<OAuthAuthorizationRequestRecord | undefined>;
  consumeAuthorizationRequest(handle: string): Promise<OAuthAuthorizationRequestRecord | undefined>;
  createAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<string>;
  consumeAuthorizationCode(code: string): Promise<OAuthAuthorizationCodeRecord | undefined>;
  issueTokenPair(input: {
    uid: string;
    clientId: string;
    scopes: string[];
    resource: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  }): Promise<IssuedOAuthTokens>;
  consumeRefreshToken(token: string): Promise<OAuthTokenRecord | undefined>;
  getAccessToken(token: string): Promise<OAuthTokenRecord | undefined>;
  revokeToken(token: string): Promise<void>;
  close(): Promise<void>;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function validRecord<T extends { expiresAt: number }>(value: T | undefined, now = Date.now()): T | undefined {
  if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) return undefined;
  return value;
}

function asAuthorizationRequest(data: DocumentData | undefined): OAuthAuthorizationRequestRecord | undefined {
  if (!data) return undefined;
  const value = data as Partial<OAuthAuthorizationRequestRecord>;
  if (
    typeof value.clientId !== "string" ||
    typeof value.redirectUri !== "string" ||
    typeof value.state !== "string" ||
    typeof value.codeChallenge !== "string" ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string") ||
    typeof value.resource !== "string" ||
    typeof value.expiresAt !== "number"
  ) return undefined;
  return value as OAuthAuthorizationRequestRecord;
}

function asAuthorizationCode(data: DocumentData | undefined): OAuthAuthorizationCodeRecord | undefined {
  if (!data) return undefined;
  const value = data as Partial<OAuthAuthorizationCodeRecord>;
  if (
    typeof value.uid !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.redirectUri !== "string" ||
    typeof value.codeChallenge !== "string" ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string") ||
    typeof value.resource !== "string" ||
    typeof value.expiresAt !== "number"
  ) return undefined;
  return value as OAuthAuthorizationCodeRecord;
}

function asToken(data: DocumentData | undefined): OAuthTokenRecord | undefined {
  if (!data) return undefined;
  const value = data as Partial<OAuthTokenRecord>;
  if (
    typeof value.uid !== "string" ||
    typeof value.clientId !== "string" ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string") ||
    typeof value.resource !== "string" ||
    typeof value.expiresAt !== "number"
  ) return undefined;
  return value as OAuthTokenRecord;
}

export class FirestoreCinemaOAuthStore implements CinemaOAuthStore {
  private readonly firestore: Firestore;
  private cleanupAfter = 0;

  constructor(projectId: string, private readonly prefix = "cinema_oauth") {
    this.firestore = new Firestore({ projectId });
  }

  private collection(kind: "requests" | "codes" | "access" | "refresh") {
    return this.firestore.collection(`${this.prefix}_${kind}`);
  }

  private async createSecretDocument(kind: "requests" | "codes", data: DocumentData): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = randomSecret();
      try {
        await this.collection(kind).doc(hashSecret(raw)).create(data);
        void this.cleanupExpired();
        return raw;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code !== "6" && code !== "ALREADY_EXISTS") throw error;
      }
    }
    throw new Error("Failed to allocate OAuth secret document");
  }

  private async consume<T>(
    kind: "requests" | "codes" | "refresh",
    raw: string,
    decode: (data: DocumentData | undefined) => T | undefined
  ): Promise<T | undefined> {
    if (!raw || raw.length > 512 || /\s/.test(raw)) return undefined;
    const ref = this.collection(kind).doc(hashSecret(raw));
    const data = await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return undefined;
      tx.delete(ref);
      return snapshot.data();
    });
    return decode(data);
  }

  async createAuthorizationRequest(record: OAuthAuthorizationRequestRecord): Promise<string> {
    return this.createSecretDocument("requests", record);
  }

  async getAuthorizationRequest(handle: string): Promise<OAuthAuthorizationRequestRecord | undefined> {
    if (!handle || handle.length > 512 || /\s/.test(handle)) return undefined;
    const ref = this.collection("requests").doc(hashSecret(handle));
    const snapshot = await ref.get();
    const record = validRecord(asAuthorizationRequest(snapshot.data()));
    if (!record && snapshot.exists) void ref.delete().catch(() => undefined);
    return record;
  }

  async consumeAuthorizationRequest(handle: string): Promise<OAuthAuthorizationRequestRecord | undefined> {
    return validRecord(await this.consume("requests", handle, asAuthorizationRequest));
  }

  async createAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<string> {
    return this.createSecretDocument("codes", record);
  }

  async consumeAuthorizationCode(code: string): Promise<OAuthAuthorizationCodeRecord | undefined> {
    return validRecord(await this.consume("codes", code, asAuthorizationCode));
  }

  async issueTokenPair(input: {
    uid: string;
    clientId: string;
    scopes: string[];
    resource: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
  }): Promise<IssuedOAuthTokens> {
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    const access: OAuthTokenRecord = {
      uid: input.uid,
      clientId: input.clientId,
      scopes: [...input.scopes],
      resource: input.resource,
      expiresAt: input.accessExpiresAt
    };
    const refresh: OAuthTokenRecord = {
      uid: input.uid,
      clientId: input.clientId,
      scopes: [...input.scopes],
      resource: input.resource,
      expiresAt: input.refreshExpiresAt
    };
    const batch = this.firestore.batch();
    batch.create(this.collection("access").doc(hashSecret(accessToken)), access);
    batch.create(this.collection("refresh").doc(hashSecret(refreshToken)), refresh);
    await batch.commit();
    void this.cleanupExpired();
    return { accessToken, refreshToken, access, refresh };
  }

  async consumeRefreshToken(token: string): Promise<OAuthTokenRecord | undefined> {
    return validRecord(await this.consume("refresh", token, asToken));
  }

  async getAccessToken(token: string): Promise<OAuthTokenRecord | undefined> {
    if (!token || token.length > 512 || /\s/.test(token)) return undefined;
    const ref = this.collection("access").doc(hashSecret(token));
    const snapshot = await ref.get();
    const record = validRecord(asToken(snapshot.data()));
    if (!record && snapshot.exists) void ref.delete().catch(() => undefined);
    return record;
  }

  async revokeToken(token: string): Promise<void> {
    if (!token || token.length > 512 || /\s/.test(token)) return;
    const id = hashSecret(token);
    const batch = this.firestore.batch();
    batch.delete(this.collection("access").doc(id));
    batch.delete(this.collection("refresh").doc(id));
    await batch.commit();
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    if (now < this.cleanupAfter) return;
    this.cleanupAfter = now + 10 * 60_000;
    try {
      for (const kind of ["requests", "codes", "access", "refresh"] as const) {
        const snapshots = await this.collection(kind).where("expiresAt", "<=", now).limit(8).get();
        if (snapshots.empty) continue;
        const batch = this.firestore.batch();
        for (const doc of snapshots.docs) batch.delete(doc.ref);
        await batch.commit();
      }
    } catch (error) {
      console.error("[japan-cinema-browser-mcp] OAuth cleanup failed", {
        errorName: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  async close(): Promise<void> {
    await this.firestore.terminate();
  }
}
