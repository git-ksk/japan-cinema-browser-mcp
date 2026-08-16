import { BrowserRuntimeError } from "./browser/runtime.js";
import type {
  CinemaSeatReadAdapter,
  CinemaShowtime,
  CinemaTheater,
  SeatAvailabilityQuery
} from "./cinema.js";
import {
  compareCinemaSeatObservations,
  type CinemaSeatFingerprints
} from "./seat-freshness.js";
import {
  recommendSeatGroups,
  type SeatGroupRecommendation,
  type SeatPreference
} from "./seat-recommendation.js";
import type { CinemaProviderId } from "./providers.js";

export interface RecommendSeatsQuery extends SeatAvailabilityQuery {
  provider: CinemaProviderId;
  count: number;
  preference: SeatPreference;
  limit?: number;
  includeSpecialSeats?: boolean;
}

export interface RecommendSeatsFreshness {
  firstObservedAt: string;
  verifiedAt: string;
  fingerprints: CinemaSeatFingerprints;
}

export interface RecommendSeatsResult {
  provider: CinemaProviderId;
  theater: CinemaTheater;
  showtime: CinemaShowtime;
  request: {
    count: number;
    preference: SeatPreference;
    limit: number;
    includeSpecialSeats: boolean;
  };
  freshness: RecommendSeatsFreshness;
  availableSeatCount: number;
  status: "recommended" | "no_confirmed_adjacent_group";
  recommendations: SeatGroupRecommendation[];
}

function observationContractViolation(
  input: RecommendSeatsQuery,
  result: Awaited<ReturnType<CinemaSeatReadAdapter["getSeatAvailability"]>>
): string | undefined {
  if (result.provider !== input.provider) return "provider does not match the requested provider";
  if (result.theater.provider !== result.provider) return "theater provider does not match the seat result provider";
  if (result.showtime.provider !== result.provider) return "showtime provider does not match the seat result provider";
  if (result.showtime.theaterId !== result.theater.id) return "showtime theater does not match the resolved theater";
  if (result.seatMap.provider !== result.provider || result.seatMap.theaterId !== result.theater.id) {
    return "seat-map provider/theater identity does not match the resolved result";
  }
  if ((result.seatMap.screen ?? "") !== (result.showtime.screen ?? "")) return "seat-map screen does not match the resolved showtime";
  if (result.showtime.date !== input.date) return "resolved showtime date does not match the request";
  if (result.showtime.movie !== input.movie) return "resolved showtime movie does not match the request";
  if (result.showtime.startTime !== input.startTime) return "resolved showtime start time does not match the request";
  if (input.screen && result.showtime.screen !== input.screen) return "resolved showtime screen does not match the request";
  if (!result.seatMap.showtimeIdentity.trim()) return "seat-map showtime identity is missing";
  return undefined;
}

function stableContextViolation(
  firstProvider: CinemaProviderId,
  secondProvider: CinemaProviderId,
  firstTheater: CinemaTheater,
  secondTheater: CinemaTheater,
  firstShowtime: CinemaShowtime,
  secondShowtime: CinemaShowtime
): string | undefined {
  if (firstProvider !== secondProvider) return "provider identity changed between seat observations";
  if (firstTheater.provider !== secondTheater.provider || firstTheater.id !== secondTheater.id) {
    return "theater identity changed between seat observations";
  }
  if (
    firstShowtime.provider !== secondShowtime.provider ||
    firstShowtime.theaterId !== secondShowtime.theaterId ||
    firstShowtime.date !== secondShowtime.date ||
    firstShowtime.movie !== secondShowtime.movie ||
    firstShowtime.startTime !== secondShowtime.startTime ||
    (firstShowtime.endTime ?? "") !== (secondShowtime.endTime ?? "") ||
    (firstShowtime.screen ?? "") !== (secondShowtime.screen ?? "")
  ) {
    return "showtime identity changed between seat observations";
  }
  return undefined;
}

/**
 * Two independent read-only observations are required. Recommendations are built
 * only from the second/current observation after context, layout, and state all
 * match the first observation exactly.
 */
export async function recommendSeats(
  input: RecommendSeatsQuery,
  adapter: CinemaSeatReadAdapter
): Promise<RecommendSeatsResult> {
  const seatInput: SeatAvailabilityQuery = {
    theater: input.theater,
    date: input.date,
    movie: input.movie,
    startTime: input.startTime,
    ...(input.screen ? { screen: input.screen } : {})
  };
  const first = await adapter.getSeatAvailability(seatInput);
  const firstViolation = observationContractViolation(input, first);
  if (firstViolation) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "First seat observation violated the requested semantic context.", {
      reason: "seat_context_invalid",
      violation: firstViolation
    });
  }
  const second = await adapter.getSeatAvailability(seatInput);
  const secondViolation = observationContractViolation(input, second);
  if (secondViolation) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Second seat observation violated the requested semantic context.", {
      reason: "seat_context_invalid",
      violation: secondViolation
    });
  }

  const identityViolation = stableContextViolation(
    first.provider,
    second.provider,
    first.theater,
    second.theater,
    first.showtime,
    second.showtime
  );
  if (identityViolation) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Seat recommendation context changed during freshness verification.", {
      reason: "seat_context_changed",
      violation: identityViolation
    });
  }

  const freshness = compareCinemaSeatObservations(first.seatMap, second.seatMap);
  if (!freshness.stable) {
    const reason = freshness.change === "context"
      ? "seat_context_changed"
      : freshness.change === "layout"
        ? "seat_layout_changed"
        : "seat_state_changed";
    const changedFingerprint = freshness.change === "context" || freshness.change === "layout" || freshness.change === "state"
      ? freshness.change
      : "state";
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Seat availability changed between bounded read-only observations. Retry with a fresh request.", {
      reason,
      firstObservedAt: first.seatMap.observedAt,
      secondObservedAt: second.seatMap.observedAt,
      firstFingerprint: freshness.first[changedFingerprint],
      secondFingerprint: freshness.second[changedFingerprint]
    });
  }

  const limit = input.limit ?? 5;
  const recommendations = recommendSeatGroups(second.seatMap, {
    count: input.count,
    preference: input.preference,
    limit,
    includeSpecialSeats: input.includeSpecialSeats === true
  });
  const availableSeatCount = second.seatMap.seats.filter((seat) => seat.state === "available").length;
  return {
    provider: second.provider,
    theater: second.theater,
    showtime: second.showtime,
    request: {
      count: input.count,
      preference: input.preference,
      limit,
      includeSpecialSeats: input.includeSpecialSeats === true
    },
    freshness: {
      firstObservedAt: first.seatMap.observedAt,
      verifiedAt: second.seatMap.observedAt,
      fingerprints: freshness.second
    },
    availableSeatCount,
    status: recommendations.length > 0 ? "recommended" : "no_confirmed_adjacent_group",
    recommendations
  };
}
