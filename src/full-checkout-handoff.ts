import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { SeatAvailabilityResult } from "./cinema.js";
import { compareCinemaSeatObservations } from "./seat-freshness.js";

const shortText = z.string().trim().min(1).max(240);
const isoDate = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM");
const seatId = z.string().trim().regex(/^[A-Z]{1,4}-\d{1,4}$/, "seat must use the reviewed TOHO identity format");

export const humanCheckoutHandoffIntentSchema = z.object({
  provider: z.literal("toho"),
  showtime: z.object({
    theater: shortText,
    theaterId: shortText.optional(),
    date: isoDate,
    movie: shortText,
    startTime: clockTime,
    screen: shortText.optional()
  }).strict(),
  seatIds: z.array(seatId).max(8).optional()
}).strict().superRefine((value, ctx) => {
  if (value.seatIds && new Set(value.seatIds).size !== value.seatIds.length) {
    ctx.addIssue({ code: "custom", path: ["seatIds"], message: "seatIds must be unique" });
  }
});

export type HumanCheckoutHandoffIntent = z.infer<typeof humanCheckoutHandoffIntentSchema>;

export class HumanCheckoutHandoffError extends Error {
  constructor(
    public readonly code: "INVALID_INTENT" | "STALE_CONTEXT" | "SEAT_UNAVAILABLE",
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HumanCheckoutHandoffError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(intent: HumanCheckoutHandoffIntent): Record<string, unknown> {
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
    seatIds: [...(intent.seatIds ?? [])].sort(compareText)
  };
}

export function humanCheckoutHandoffDigest(intent: HumanCheckoutHandoffIntent): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(intent))).digest("hex")}`;
}

function assertResultMatchesIntent(intent: HumanCheckoutHandoffIntent, result: SeatAvailabilityResult<"toho">, label: string): void {
  const showtime = result.showtime;
  const map = result.seatMap;
  if (
    result.provider !== "toho" || showtime.provider !== "toho" || map.provider !== "toho" ||
    showtime.theater !== intent.showtime.theater || showtime.date !== intent.showtime.date ||
    showtime.movie !== intent.showtime.movie || showtime.startTime !== intent.showtime.startTime ||
    (intent.showtime.theaterId !== undefined && map.theaterId !== intent.showtime.theaterId) ||
    (intent.showtime.screen !== undefined && showtime.screen !== intent.showtime.screen) ||
    (intent.showtime.screen !== undefined && map.screen !== intent.showtime.screen)
  ) {
    throw new HumanCheckoutHandoffError("STALE_CONTEXT", `${label} TOHO seat observation does not match the exact Human checkout intent.`);
  }
}

export function validateHumanCheckoutHandoffSeatReads(
  rawIntent: HumanCheckoutHandoffIntent,
  first: SeatAvailabilityResult<"toho">,
  second: SeatAvailabilityResult<"toho">
): { intent: HumanCheckoutHandoffIntent; showtimeIdentity: string; sourceUrl: string } {
  const parsed = humanCheckoutHandoffIntentSchema.safeParse(rawIntent);
  if (!parsed.success) {
    throw new HumanCheckoutHandoffError("INVALID_INTENT", "Human checkout handoff intent is invalid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  const intent = parsed.data;
  assertResultMatchesIntent(intent, first, "First");
  assertResultMatchesIntent(intent, second, "Second");
  const freshness = compareCinemaSeatObservations(first.seatMap, second.seatMap);
  if (!freshness.stable) {
    throw new HumanCheckoutHandoffError("STALE_CONTEXT", "TOHO seat state changed between the two pre-Handoff observations.", {
      change: freshness.change
    });
  }

  const intendedSeats = intent.seatIds ?? [];
  if (intendedSeats.length === 0 && !second.seatMap.seats.some((seat) => seat.state === "available")) {
    throw new HumanCheckoutHandoffError("SEAT_UNAVAILABLE", "No currently available seat remains on the exact TOHO showtime.");
  }
  for (const id of intendedSeats) {
    const seat = second.seatMap.seats.find((candidate) => candidate.id === id);
    if (!seat || seat.state !== "available") {
      throw new HumanCheckoutHandoffError("SEAT_UNAVAILABLE", `Requested seat ${id} is no longer confirmed available.`, {
        seatId: id,
        state: seat?.state ?? "missing"
      });
    }
  }

  return {
    intent,
    showtimeIdentity: second.seatMap.showtimeIdentity,
    sourceUrl: second.seatMap.sourceUrl
  };
}
