import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { CinemaSeatFingerprints, CinemaSeatFreshnessComparison } from "./seat-freshness.js";
import { compareCinemaSeatObservations, fingerprintCinemaSeatMap } from "./seat-freshness.js";
import type { CinemaShowtime, CinemaSeatMap, SeatAvailabilityResult } from "./cinema.js";
import { assertProviderCapability, type CinemaProviderId } from "./providers.js";

const providerSchema = z.enum(["toho", "aeon", "109"]);
const isoDateSchema = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM");
const shortTextSchema = z.string().trim().min(1).max(240);
const seatIdSchema = z.string().trim().min(1).max(80);
const ticketIdSchema = z.string().trim().min(1).max(160);

export const CINEMA_TICKET_CATEGORIES = [
  "standard",
  "child",
  "student",
  "senior",
  "member",
  "accessibility",
  "special",
  "other"
] as const;
export type CinemaTicketCategory = (typeof CINEMA_TICKET_CATEGORIES)[number];

export const CINEMA_CHECKOUT_STAGES = [
  "seat_selection",
  "ticket_selection",
  "member_or_guest",
  "purchaser_information",
  "consent",
  "payment",
  "review",
  "other"
] as const;
export type CinemaCheckoutStage = (typeof CINEMA_CHECKOUT_STAGES)[number];

export const CINEMA_CHECKOUT_HUMAN_REASONS = [
  "authentication",
  "purchaser_information",
  "consent",
  "payment",
  "access_challenge",
  "ticket_eligibility",
  "provider_required_manual_step"
] as const;
export type CinemaCheckoutHumanReason = (typeof CINEMA_CHECKOUT_HUMAN_REASONS)[number];

const ticketCategorySchema = z.enum(CINEMA_TICKET_CATEGORIES);
const checkoutStageSchema = z.enum(CINEMA_CHECKOUT_STAGES);
const checkoutHumanReasonSchema = z.enum(CINEMA_CHECKOUT_HUMAN_REASONS);

const checkoutShowtimeIntentSchema = z.object({
  theater: shortTextSchema,
  theaterId: shortTextSchema.optional(),
  date: isoDateSchema,
  movie: shortTextSchema,
  startTime: clockTimeSchema,
  screen: shortTextSchema.optional()
}).strict();

const ticketEligibilityAcknowledgementSchema = z.object({
  confirmed: z.literal(true),
  renderedPriceYen: z.number().int().nonnegative().max(1_000_000),
  eligibilityText: z.string().trim().min(1).max(500)
}).strict();

const checkoutTicketChoiceSchema = z.object({
  providerTicketTypeId: ticketIdSchema.optional(),
  label: shortTextSchema,
  quantity: z.number().int().min(1).max(8),
  eligibilityAcknowledgement: ticketEligibilityAcknowledgementSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.eligibilityAcknowledgement !== undefined && value.providerTicketTypeId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["providerTicketTypeId"],
      message: "eligibility acknowledgement requires one exact provider ticket type id"
    });
  }
});

export const cinemaCheckoutIntentSchema = z.object({
  provider: providerSchema,
  showtime: checkoutShowtimeIntentSchema,
  seatIds: z.array(seatIdSchema).min(1).max(8),
  ticketChoices: z.array(checkoutTicketChoiceSchema).min(1).max(8)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.seatIds).size !== value.seatIds.length) {
    ctx.addIssue({ code: "custom", path: ["seatIds"], message: "seatIds must be unique" });
  }
  const ticketKeys = value.ticketChoices.map((choice) => `${choice.providerTicketTypeId ?? ""}|${choice.label}`);
  if (new Set(ticketKeys).size !== ticketKeys.length) {
    ctx.addIssue({ code: "custom", path: ["ticketChoices"], message: "ticket choices must have unique provider identity/label pairs" });
  }
  const quantity = value.ticketChoices.reduce((sum, choice) => sum + choice.quantity, 0);
  if (quantity !== value.seatIds.length) {
    ctx.addIssue({
      code: "custom",
      path: ["ticketChoices"],
      message: "ticket quantity must exactly match the intended seat count"
    });
  }
});

export type CinemaCheckoutIntent = z.infer<typeof cinemaCheckoutIntentSchema>;
export type CinemaCheckoutShowtimeIntent = CinemaCheckoutIntent["showtime"];
export type CinemaCheckoutTicketChoice = CinemaCheckoutIntent["ticketChoices"][number];

const renderedTicketTypeSchema = z.object({
  providerTicketTypeId: ticketIdSchema.optional(),
  label: shortTextSchema,
  priceYen: z.number().int().nonnegative().max(1_000_000).optional(),
  currency: z.literal("JPY"),
  category: ticketCategorySchema.optional(),
  eligibilityText: z.string().trim().min(1).max(500).optional(),
  restrictionText: z.string().trim().min(1).max(500).optional(),
  minQuantity: z.number().int().min(1).max(8).optional(),
  maxQuantity: z.number().int().min(1).max(8).optional(),
  humanReviewRequired: z.boolean().optional(),
  humanReviewReason: checkoutHumanReasonSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.minQuantity !== undefined && value.maxQuantity !== undefined && value.minQuantity > value.maxQuantity) {
    ctx.addIssue({ code: "custom", path: ["minQuantity"], message: "minQuantity must not exceed maxQuantity" });
  }
  if (value.humanReviewReason !== undefined && value.humanReviewRequired !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["humanReviewReason"],
      message: "humanReviewReason requires humanReviewRequired=true"
    });
  }
});

export type CinemaRenderedTicketType = z.infer<typeof renderedTicketTypeSchema>;

const renderedTicketSelectionSchema = z.object({
  providerTicketTypeId: ticketIdSchema.optional(),
  label: shortTextSchema,
  quantity: z.number().int().min(1).max(8),
  unitPriceYen: z.number().int().nonnegative().max(1_000_000).optional(),
  lineTotalYen: z.number().int().nonnegative().max(8_000_000).optional()
}).strict();

const checkoutFeeSchema = z.object({
  label: shortTextSchema,
  amountYen: z.number().int().nonnegative().max(8_000_000)
}).strict();

const renderedCheckoutSummarySchema = z.object({
  provider: providerSchema,
  theater: shortTextSchema,
  theaterId: shortTextSchema.optional(),
  movie: shortTextSchema,
  date: isoDateSchema,
  startTime: clockTimeSchema,
  screen: shortTextSchema.optional(),
  seats: z.array(seatIdSchema).min(1).max(8),
  tickets: z.array(renderedTicketSelectionSchema).min(1).max(8),
  subtotalYen: z.number().int().nonnegative().max(8_000_000).optional(),
  fees: z.array(checkoutFeeSchema).max(20).optional(),
  totalYen: z.number().int().nonnegative().max(8_000_000).optional(),
  currency: z.literal("JPY"),
  stage: checkoutStageSchema,
  providerStageLabel: z.string().trim().min(1).max(160).optional(),
  observedAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.seats).size !== value.seats.length) {
    ctx.addIssue({ code: "custom", path: ["seats"], message: "summary seats must be unique" });
  }
  const ticketQuantity = value.tickets.reduce((sum, ticket) => sum + ticket.quantity, 0);
  if (ticketQuantity !== value.seats.length) {
    ctx.addIssue({ code: "custom", path: ["tickets"], message: "summary ticket quantity must match seat count" });
  }
  if (value.subtotalYen !== undefined && value.totalYen !== undefined && value.fees !== undefined) {
    const expectedTotal = value.subtotalYen + value.fees.reduce((sum, fee) => sum + fee.amountYen, 0);
    if (expectedTotal !== value.totalYen) {
      ctx.addIssue({ code: "custom", path: ["totalYen"], message: "summary total contradicts subtotal plus fees" });
    }
  }
  if (value.subtotalYen !== undefined && value.tickets.every((ticket) => ticket.lineTotalYen !== undefined)) {
    const lineTotal = value.tickets.reduce((sum, ticket) => sum + (ticket.lineTotalYen ?? 0), 0);
    if (lineTotal !== value.subtotalYen) {
      ctx.addIssue({ code: "custom", path: ["subtotalYen"], message: "summary subtotal contradicts rendered ticket line totals" });
    }
  }
});

export type CinemaRenderedCheckoutSummary = z.infer<typeof renderedCheckoutSummarySchema>;

export interface CinemaCheckoutSummary extends CinemaRenderedCheckoutSummary {
  /** Stable digest over material rendered facts. `observedAt` is deliberately excluded. */
  materialFingerprint: string;
}

export interface CinemaCheckoutFreshnessBinding {
  provider: CinemaProviderId;
  showtimeIdentity: string;
  sourceUrl: string;
  firstObservedAt: string;
  verifiedAt: string;
  fingerprints: CinemaSeatFingerprints;
}

export interface CinemaResolvedTicketChoice {
  ticketType: CinemaRenderedTicketType;
  quantity: number;
}

export interface CinemaCheckoutSeatPlan {
  provider: CinemaProviderId;
  theaterId: string;
  theater: string;
  showtime: CinemaShowtime;
  seatIds: string[];
  freshness: CinemaCheckoutFreshnessBinding;
}

export type CinemaCheckoutBlockedReason =
  | "provider_capability_disabled"
  | "invalid_intent"
  | "stale_context"
  | "seat_unavailable"
  | "ticket_unavailable"
  | "ticket_constraint"
  | "ticket_confirmation_required"
  | "summary_mismatch"
  | "ambiguous_rendered_state";

export type CinemaCheckoutPreparationResult =
  | { status: "blocked"; provider: CinemaProviderId; reason: CinemaCheckoutBlockedReason }
  | {
      status: "human_action_required";
      provider: CinemaProviderId;
      reason: CinemaCheckoutHumanReason;
      freshness?: CinemaCheckoutFreshnessBinding;
    }
  | {
      status: "prepared";
      provider: CinemaProviderId;
      summary: CinemaCheckoutSummary;
      freshness: CinemaCheckoutFreshnessBinding;
    };

export class CheckoutCoreError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INTENT"
      | "STALE_CONTEXT"
      | "SEAT_UNAVAILABLE"
      | "TICKET_UNAVAILABLE"
      | "TICKET_CONSTRAINT"
      | "TICKET_CONFIRMATION_REQUIRED"
      | "SUMMARY_MISMATCH"
      | "AMBIGUOUS_RENDERED_STATE",
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CheckoutCoreError";
  }
}

function checkoutErrorFromZod(error: z.ZodError): CheckoutCoreError {
  return new CheckoutCoreError("INVALID_INTENT", "Checkout intent is outside the reviewed Phase 4 contract.", {
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
  });
}

export function parseCinemaCheckoutIntent(value: unknown): CinemaCheckoutIntent {
  const parsed = cinemaCheckoutIntentSchema.safeParse(value);
  if (!parsed.success) throw checkoutErrorFromZod(parsed.error);
  return parsed.data;
}

export function parseRenderedTicketType(value: unknown): CinemaRenderedTicketType {
  const parsed = renderedTicketTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "Rendered ticket facts violate the checkout contract.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return parsed.data;
}

/** Runtime fence for the future tool. It remains false for every provider in #49. */
export function assertCheckoutPreparationEnabled(provider: CinemaProviderId): void {
  assertProviderCapability(provider, "checkoutPreparation");
}

function showtimeViolation(intent: CinemaCheckoutIntent, result: SeatAvailabilityResult): string | undefined {
  if (result.provider !== intent.provider) return "seat result provider does not match intent";
  if (result.theater.provider !== intent.provider || result.showtime.provider !== intent.provider) {
    return "rendered theater/showtime provider does not match intent";
  }
  if (result.showtime.theaterId !== result.theater.id || result.seatMap.theaterId !== result.theater.id) {
    return "rendered theater identity is inconsistent";
  }
  if (result.seatMap.provider !== intent.provider) return "seat-map provider does not match intent";
  if (result.theater.name !== intent.showtime.theater) return "theater name does not match intent";
  if (intent.showtime.theaterId && result.theater.id !== intent.showtime.theaterId) return "theater id does not match intent";
  if (result.showtime.date !== intent.showtime.date) return "showtime date does not match intent";
  if (result.showtime.movie !== intent.showtime.movie) return "movie title does not match intent";
  if (result.showtime.startTime !== intent.showtime.startTime) return "showtime start time does not match intent";
  if (intent.showtime.screen && result.showtime.screen !== intent.showtime.screen) return "screen does not match intent";
  if ((result.seatMap.screen ?? "") !== (result.showtime.screen ?? "")) return "seat-map screen does not match showtime";
  if (!result.seatMap.showtimeIdentity.trim()) return "seat-map showtime identity is missing";
  return undefined;
}

function stableShowtimeViolation(first: SeatAvailabilityResult, second: SeatAvailabilityResult): string | undefined {
  if (first.provider !== second.provider) return "provider changed between observations";
  if (first.theater.provider !== second.theater.provider || first.theater.id !== second.theater.id || first.theater.name !== second.theater.name) {
    return "theater changed between observations";
  }
  const left = first.showtime;
  const right = second.showtime;
  if (
    left.provider !== right.provider ||
    left.theaterId !== right.theaterId ||
    left.theater !== right.theater ||
    left.date !== right.date ||
    left.movie !== right.movie ||
    left.startTime !== right.startTime ||
    (left.endTime ?? "") !== (right.endTime ?? "") ||
    (left.screen ?? "") !== (right.screen ?? "")
  ) {
    return "showtime changed between observations";
  }
  return undefined;
}

function staleDetails(comparison: CinemaSeatFreshnessComparison): Record<string, unknown> {
  return { change: comparison.change, first: comparison.first, second: comparison.second };
}

/**
 * Validate one exact intended seat set against two independent read-only observations.
 * The second/current observation is usable only when context, layout, and state are stable.
 * No alternate seat is ever substituted.
 */
export function validateCheckoutSeatIntent(
  intent: CinemaCheckoutIntent,
  first: SeatAvailabilityResult,
  second: SeatAvailabilityResult
): CinemaCheckoutSeatPlan {
  const firstViolation = showtimeViolation(intent, first);
  if (firstViolation) {
    throw new CheckoutCoreError("STALE_CONTEXT", "First seat observation does not match the checkout intent.", {
      violation: firstViolation
    });
  }
  const secondViolation = showtimeViolation(intent, second);
  if (secondViolation) {
    throw new CheckoutCoreError("STALE_CONTEXT", "Current seat observation does not match the checkout intent.", {
      violation: secondViolation
    });
  }
  const stableViolation = stableShowtimeViolation(first, second);
  if (stableViolation) {
    throw new CheckoutCoreError("STALE_CONTEXT", "Showtime context changed during checkout freshness verification.", {
      violation: stableViolation
    });
  }

  const freshness = compareCinemaSeatObservations(first.seatMap, second.seatMap);
  if (!freshness.stable) {
    throw new CheckoutCoreError(
      "STALE_CONTEXT",
      "Seat context, layout, or availability changed before checkout mutation.",
      staleDetails(freshness)
    );
  }

  const currentSeats = new Map(second.seatMap.seats.map((seat) => [seat.id, seat]));
  for (const seatId of intent.seatIds) {
    const seat = currentSeats.get(seatId);
    if (!seat || seat.state !== "available") {
      throw new CheckoutCoreError("SEAT_UNAVAILABLE", "An exact intended seat is no longer confirmed available.", {
        seatId,
        state: seat?.state ?? "missing"
      });
    }
  }

  return {
    provider: second.provider,
    theaterId: second.theater.id,
    theater: second.theater.name,
    showtime: second.showtime,
    seatIds: [...intent.seatIds],
    freshness: {
      provider: second.provider,
      showtimeIdentity: second.seatMap.showtimeIdentity,
      sourceUrl: second.seatMap.sourceUrl,
      firstObservedAt: first.seatMap.observedAt,
      verifiedAt: second.seatMap.observedAt,
      fingerprints: freshness.second
    }
  };
}

function ticketIdentityMatches(choice: CinemaCheckoutTicketChoice, ticket: CinemaRenderedTicketType): boolean {
  if (choice.providerTicketTypeId !== undefined) {
    return ticket.providerTicketTypeId === choice.providerTicketTypeId && ticket.label === choice.label;
  }
  return ticket.label === choice.label;
}

/** Resolve only exact rendered ticket facts. Labels are not heuristically classified and eligibility is never inferred. */
export function resolveCheckoutTicketChoices(
  intent: CinemaCheckoutIntent,
  renderedTicketTypes: readonly CinemaRenderedTicketType[]
): { selections: CinemaResolvedTicketChoice[]; humanReviewReasons: CinemaCheckoutHumanReason[] } {
  const parsed = renderedTicketTypes.map((ticket) => parseRenderedTicketType(ticket));
  const selections: CinemaResolvedTicketChoice[] = [];
  const humanReasons = new Set<CinemaCheckoutHumanReason>();

  for (const choice of intent.ticketChoices) {
    const matches = parsed.filter((ticket) => ticketIdentityMatches(choice, ticket));
    if (matches.length === 0) {
      throw new CheckoutCoreError("TICKET_UNAVAILABLE", "An exact intended ticket type is not present in the current rendered UI.", {
        providerTicketTypeId: choice.providerTicketTypeId,
        label: choice.label
      });
    }
    if (matches.length !== 1) {
      throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "Rendered ticket type identity is ambiguous.", {
        providerTicketTypeId: choice.providerTicketTypeId,
        label: choice.label,
        matchCount: matches.length
      });
    }
    const ticket = matches[0]!;
    if (ticket.minQuantity !== undefined && choice.quantity < ticket.minQuantity) {
      throw new CheckoutCoreError("TICKET_CONSTRAINT", "Requested ticket quantity is below the rendered provider minimum.", {
        label: ticket.label,
        requested: choice.quantity,
        minimum: ticket.minQuantity
      });
    }
    if (ticket.maxQuantity !== undefined && choice.quantity > ticket.maxQuantity) {
      throw new CheckoutCoreError("TICKET_CONSTRAINT", "Requested ticket quantity exceeds the rendered provider maximum.", {
        label: ticket.label,
        requested: choice.quantity,
        maximum: ticket.maxQuantity
      });
    }
    if (ticket.humanReviewRequired === true) {
      humanReasons.add(ticket.humanReviewReason ?? "ticket_eligibility");
    }
    selections.push({ ticketType: ticket, quantity: choice.quantity });
  }

  const quantity = selections.reduce((sum, item) => sum + item.quantity, 0);
  if (quantity !== intent.seatIds.length) {
    throw new CheckoutCoreError("TICKET_CONSTRAINT", "Resolved ticket quantity no longer matches the exact intended seat count.", {
      seats: intent.seatIds.length,
      tickets: quantity
    });
  }

  return { selections, humanReviewReasons: [...humanReasons] };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSeatSets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}

function renderedTicketSelectionMatchesIntent(
  choice: CinemaCheckoutTicketChoice,
  ticket: CinemaRenderedCheckoutSummary["tickets"][number]
): boolean {
  if (choice.providerTicketTypeId !== undefined) {
    return choice.providerTicketTypeId === ticket.providerTicketTypeId &&
      choice.label === ticket.label &&
      choice.quantity === ticket.quantity;
  }
  return choice.label === ticket.label && choice.quantity === ticket.quantity;
}

function summaryMatchesIntent(intent: CinemaCheckoutIntent, summary: CinemaRenderedCheckoutSummary): string | undefined {
  if (summary.provider !== intent.provider) return "provider does not match intent";
  if (summary.theater !== intent.showtime.theater) return "theater does not match intent";
  if (intent.showtime.theaterId && summary.theaterId !== intent.showtime.theaterId) return "theater id does not match intent";
  if (summary.movie !== intent.showtime.movie) return "movie does not match intent";
  if (summary.date !== intent.showtime.date) return "date does not match intent";
  if (summary.startTime !== intent.showtime.startTime) return "start time does not match intent";
  if (intent.showtime.screen && summary.screen !== intent.showtime.screen) return "screen does not match intent";
  if (!compareSeatSets(summary.seats, intent.seatIds)) return "rendered seats do not exactly match intended seats";

  const unmatched = [...summary.tickets];
  for (const choice of intent.ticketChoices) {
    const index = unmatched.findIndex((ticket) => renderedTicketSelectionMatchesIntent(choice, ticket));
    if (index < 0) return `rendered ticket selection does not match intent: ${choice.label}`;
    unmatched.splice(index, 1);
  }
  if (unmatched.length > 0) return "rendered summary contains additional ticket selections";
  return undefined;
}

function materialSummaryFacts(summary: CinemaRenderedCheckoutSummary): Record<string, unknown> {
  return {
    provider: summary.provider,
    theater: summary.theater,
    theaterId: summary.theaterId ?? null,
    movie: summary.movie,
    date: summary.date,
    startTime: summary.startTime,
    screen: summary.screen ?? null,
    seats: [...summary.seats].sort(),
    tickets: [...summary.tickets]
      .map((ticket) => ({
        providerTicketTypeId: ticket.providerTicketTypeId ?? null,
        label: ticket.label,
        quantity: ticket.quantity,
        unitPriceYen: ticket.unitPriceYen ?? null,
        lineTotalYen: ticket.lineTotalYen ?? null
      }))
      .sort((a, b) => compareText(`${a.providerTicketTypeId ?? ""}|${a.label}`, `${b.providerTicketTypeId ?? ""}|${b.label}`)),
    subtotalYen: summary.subtotalYen ?? null,
    fees: summary.fees
      ? [...summary.fees]
          .map((fee) => ({ ...fee }))
          .sort((a, b) => compareText(a.label, b.label) || a.amountYen - b.amountYen)
      : null,
    totalYen: summary.totalYen ?? null,
    currency: summary.currency,
    stage: summary.stage,
    providerStageLabel: summary.providerStageLabel ?? null
  };
}

/**
 * Accept only provider-adapter rendered facts, verify they still match user intent, and compute a material digest.
 * The MCP intent schema has no summary/amount/final-control fields, so caller-provided values cannot become transaction truth.
 */
export function createCheckoutSummaryFromRenderedFacts(
  intent: CinemaCheckoutIntent,
  value: unknown
): CinemaCheckoutSummary {
  const parsed = renderedCheckoutSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "Rendered checkout summary violates the provider-neutral contract.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  const mismatch = summaryMatchesIntent(intent, parsed.data);
  if (mismatch) {
    throw new CheckoutCoreError("SUMMARY_MISMATCH", "Current rendered checkout summary does not match the original user intent.", {
      violation: mismatch
    });
  }
  const materialFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(materialSummaryFacts(parsed.data)))
    .digest("hex")}`;
  return { ...parsed.data, materialFingerprint };
}

/** Current seat-map digest helper for adapters binding a future semantic mutation to a prior reviewed read. */
export function currentCheckoutSeatFingerprints(map: CinemaSeatMap): CinemaSeatFingerprints {
  return fingerprintCinemaSeatMap(map);
}
