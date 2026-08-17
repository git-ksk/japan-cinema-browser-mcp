import { createHash } from "node:crypto";
import type { CinemaSeatFingerprints } from "./seat-freshness.js";
import type { CinemaCheckoutIntent } from "./checkout.js";
import type { CinemaProviderId } from "./providers.js";

export const CHECKOUT_CONTINUATION_BOUNDARIES = ["toho_terms_consent_next"] as const;
export type CheckoutContinuationBoundary = (typeof CHECKOUT_CONTINUATION_BOUNDARIES)[number];

export interface CheckoutContinuationSourceSurface {
  host: string;
  pathname: string;
}

export interface CheckoutContinuationBinding {
  version: 1;
  provider: CinemaProviderId;
  boundary: CheckoutContinuationBoundary;
  intentDigest: string;
  continuationDigest: string;
  theaterId: string;
  showtimeIdentity: string;
  selectedSeatIds: string[];
  preHumanFingerprints: CinemaSeatFingerprints;
  sourceSurface: CheckoutContinuationSourceSurface;
  browserTargetId: string;
  createdAt: number;
  expiresAt: number;
}

export interface CheckoutContinuationBindingInput {
  provider: CinemaProviderId;
  boundary: CheckoutContinuationBoundary;
  intent: CinemaCheckoutIntent;
  theaterId: string;
  showtimeIdentity: string;
  selectedSeatIds: readonly string[];
  preHumanFingerprints: CinemaSeatFingerprints;
  sourceSurface: CheckoutContinuationSourceSurface;
  browserTargetId: string;
}

export interface CheckoutContinuationMatch {
  provider: CinemaProviderId;
  boundary: CheckoutContinuationBoundary;
  intent: CinemaCheckoutIntent;
  theaterId: string;
  showtimeIdentity: string;
  selectedSeatIds: readonly string[];
  browserTargetId: string;
}

export class CheckoutContinuationError extends Error {
  constructor(
    public readonly code: "BINDING_MISSING" | "BINDING_EXPIRED" | "BINDING_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "CheckoutContinuationError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalIntent(intent: CinemaCheckoutIntent): Record<string, unknown> {
  return {
    provider: intent.provider,
    showtime: {
      theater: intent.showtime.theater,
      theaterId: intent.showtime.theaterId ?? null,
      date: intent.showtime.date,
      movie: intent.showtime.movie,
      startTime: intent.showtime.startTime,
      screen: intent.showtime.screen ?? null
    },
    seatIds: [...intent.seatIds].sort(compareText),
    ticketChoices: [...intent.ticketChoices]
      .map((choice) => ({
        providerTicketTypeId: choice.providerTicketTypeId ?? null,
        label: choice.label,
        quantity: choice.quantity
      }))
      .sort((a, b) => compareText(`${a.providerTicketTypeId ?? ""}|${a.label}`, `${b.providerTicketTypeId ?? ""}|${b.label}`))
  };
}

export function checkoutIntentDigest(intent: CinemaCheckoutIntent): string {
  return sha256(canonicalIntent(intent));
}

function validateSourceSurface(surface: CheckoutContinuationSourceSurface): void {
  if (!/^[a-z0-9.-]+$/i.test(surface.host) || surface.host.includes("..")) {
    throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation source host is invalid.");
  }
  if (!surface.pathname.startsWith("/") || surface.pathname.includes("?") || surface.pathname.includes("#")) {
    throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation source pathname is invalid.");
  }
}

function materialForDigest(input: Omit<CheckoutContinuationBinding, "continuationDigest" | "createdAt" | "expiresAt" | "version">): Record<string, unknown> {
  return {
    provider: input.provider,
    boundary: input.boundary,
    intentDigest: input.intentDigest,
    theaterId: input.theaterId,
    showtimeIdentity: input.showtimeIdentity,
    selectedSeatIds: [...input.selectedSeatIds].sort(compareText),
    preHumanFingerprints: input.preHumanFingerprints,
    sourceSurface: input.sourceSurface,
    browserTargetId: input.browserTargetId
  };
}

function cloneBinding(binding: CheckoutContinuationBinding): CheckoutContinuationBinding {
  return {
    ...binding,
    selectedSeatIds: [...binding.selectedSeatIds],
    preHumanFingerprints: { ...binding.preHumanFingerprints },
    sourceSurface: { ...binding.sourceSurface }
  };
}

export class CheckoutContinuationStore {
  private active?: CheckoutContinuationBinding;

  constructor(
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Checkout continuation TTL must be a positive integer.");
  }

  create(input: CheckoutContinuationBindingInput): CheckoutContinuationBinding {
    validateSourceSurface(input.sourceSurface);
    if (input.provider !== input.intent.provider) {
      throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation provider does not match intent.");
    }
    if (input.boundary !== "toho_terms_consent_next" || input.provider !== "toho") {
      throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation boundary is not reviewed for this provider.");
    }
    if (!input.browserTargetId.trim() || !input.theaterId.trim() || !input.showtimeIdentity.trim()) {
      throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation identity is incomplete.");
    }
    const selectedSeatIds = [...input.selectedSeatIds].sort(compareText);
    if (selectedSeatIds.length === 0 || new Set(selectedSeatIds).size !== selectedSeatIds.length) {
      throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation selected-seat set is invalid.");
    }
    const intended = [...input.intent.seatIds].sort(compareText);
    if (selectedSeatIds.length !== intended.length || selectedSeatIds.some((id, index) => id !== intended[index])) {
      throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation selected seats do not exactly match intent.");
    }
    const createdAt = this.now();
    const intentDigest = checkoutIntentDigest(input.intent);
    const material = {
      provider: input.provider,
      boundary: input.boundary,
      intentDigest,
      theaterId: input.theaterId,
      showtimeIdentity: input.showtimeIdentity,
      selectedSeatIds,
      preHumanFingerprints: { ...input.preHumanFingerprints },
      sourceSurface: { ...input.sourceSurface },
      browserTargetId: input.browserTargetId
    };
    const binding: CheckoutContinuationBinding = {
      version: 1,
      ...material,
      continuationDigest: sha256(materialForDigest(material)),
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    this.active = binding;
    return cloneBinding(binding);
  }

  peek(): CheckoutContinuationBinding | undefined {
    const active = this.active;
    if (!active) return undefined;
    if (this.now() >= active.expiresAt) {
      this.active = undefined;
      return undefined;
    }
    return cloneBinding(active);
  }

  requireMatching(match: CheckoutContinuationMatch): CheckoutContinuationBinding {
    const active = this.active;
    if (!active) throw new CheckoutContinuationError("BINDING_MISSING", "No active checkout continuation binding exists.");
    if (this.now() >= active.expiresAt) {
      this.active = undefined;
      throw new CheckoutContinuationError("BINDING_EXPIRED", "Checkout continuation binding expired.");
    }
    const intentDigest = checkoutIntentDigest(match.intent);
    const seats = [...match.selectedSeatIds].sort(compareText);
    const sameSeats = seats.length === active.selectedSeatIds.length && seats.every((id, index) => id === active.selectedSeatIds[index]);
    if (
      active.provider !== match.provider ||
      active.boundary !== match.boundary ||
      active.intentDigest !== intentDigest ||
      active.theaterId !== match.theaterId ||
      active.showtimeIdentity !== match.showtimeIdentity ||
      active.browserTargetId !== match.browserTargetId ||
      !sameSeats
    ) {
      this.active = undefined;
      throw new CheckoutContinuationError("BINDING_MISMATCH", "Checkout continuation material binding no longer matches current intent/context.");
    }
    return cloneBinding(active);
  }

  consumeMatching(match: CheckoutContinuationMatch): CheckoutContinuationBinding {
    const binding = this.requireMatching(match);
    this.active = undefined;
    return binding;
  }

  clear(): void {
    this.active = undefined;
  }
}
