import { createHash, randomBytes } from "node:crypto";
import type { CinemaProviderId } from "./providers.js";

export interface PurchaseSummary {
  provider: CinemaProviderId;
  theater: string;
  movie: string;
  date: string;
  time: string;
  seats: string[];
  ticketSummary: string;
  amountYen?: number;
  finalControlLabel: string;
}

export interface ConsumedPurchaseConfirmation {
  summary: PurchaseSummary;
  expectedUrl: string;
}

interface PurchaseConfirmation {
  id: string;
  digest: string;
  summary: PurchaseSummary;
  expectedUrl: string;
  expiresAt: number;
  used: boolean;
}

export class PurchaseGateError extends Error {
  constructor(
    public readonly code: "CONFIRMATION_NOT_FOUND" | "CONFIRMATION_EXPIRED" | "CONFIRMATION_USED",
    message: string
  ) {
    super(message);
    this.name = "PurchaseGateError";
  }
}

function digestSummary(summary: PurchaseSummary, expectedUrl: string): string {
  return createHash("sha256").update(JSON.stringify({ summary, expectedUrl })).digest("base64url");
}

export class PurchaseGate {
  private readonly confirmations = new Map<string, PurchaseConfirmation>();

  constructor(private readonly ttlMs: number) {}

  prepare(summary: PurchaseSummary, expectedUrl: string): { confirmationId: string; expiresAt: string; digest: string } {
    this.prune();
    const id = `purchase_${randomBytes(16).toString("base64url")}`;
    const digest = digestSummary(summary, expectedUrl);
    const expiresAt = Date.now() + this.ttlMs;
    this.confirmations.set(id, { id, digest, summary, expectedUrl, expiresAt, used: false });
    return { confirmationId: id, expiresAt: new Date(expiresAt).toISOString(), digest };
  }

  consume(id: string): ConsumedPurchaseConfirmation {
    this.prune();
    const item = this.confirmations.get(id);
    if (!item) throw new PurchaseGateError("CONFIRMATION_NOT_FOUND", "Purchase confirmation was not found");
    if (item.used) throw new PurchaseGateError("CONFIRMATION_USED", "Purchase confirmation was already used");
    if (item.expiresAt <= Date.now()) {
      this.confirmations.delete(id);
      throw new PurchaseGateError("CONFIRMATION_EXPIRED", "Purchase confirmation expired");
    }
    item.used = true;
    return { summary: item.summary, expectedUrl: item.expectedUrl };
  }

  clear(): void {
    this.confirmations.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, item] of this.confirmations) {
      if (item.expiresAt <= now || item.used) this.confirmations.delete(id);
    }
  }
}
