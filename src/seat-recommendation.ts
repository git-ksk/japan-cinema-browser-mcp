import type { CinemaSeat, CinemaSeatMap } from "./cinema.js";

export type SeatPreference = "center" | "rear" | "rear-middle" | "aisle";

export interface SeatRecommendationRequest {
  count: number;
  preference: SeatPreference;
  /** Maximum number of ranked groups to return. Defaults to 5, capped at 20. */
  limit?: number;
  /** Defaults to true. Explicit provider groups are never split when enabled. */
  preserveGroups?: boolean;
}

export interface SeatRecommendationScore {
  center: number;
  rear: number;
  aisle: number;
  total: number;
}

export interface SeatGroupRecommendation {
  seatIds: string[];
  score: SeatRecommendationScore;
}

export class SeatRecommendationError extends Error {
  constructor(
    public readonly code: "INVALID_SEAT_MAP" | "INVALID_REQUEST",
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "SeatRecommendationError";
  }
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rounded(value: number): number {
  return Math.round(clamp01(value) * 1_000_000) / 1_000_000;
}

function assertMapIntegrity(map: CinemaSeatMap): void {
  if (!map.showtimeIdentity.trim() || !map.sourceUrl.trim() || !map.observedAt.trim()) {
    throw new SeatRecommendationError("INVALID_SEAT_MAP", "Seat-map provenance is incomplete.");
  }
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const seat of map.seats) {
    if (!seat.id.trim()) {
      throw new SeatRecommendationError("INVALID_SEAT_MAP", "Seat identity must not be empty.");
    }
    if (ids.has(seat.id)) {
      throw new SeatRecommendationError("INVALID_SEAT_MAP", "Seat identities must be unique.", { seatId: seat.id });
    }
    ids.add(seat.id);
    if (seat.unavailableReason !== undefined && seat.state !== "unavailable") {
      throw new SeatRecommendationError(
        "INVALID_SEAT_MAP",
        "Unavailable reason must only be attached to an unavailable seat.",
        { seatId: seat.id, state: seat.state }
      );
    }
    if ((seat.rowIndex !== undefined && !finiteNonNegativeInteger(seat.rowIndex)) ||
        (seat.columnIndex !== undefined && !finiteNonNegativeInteger(seat.columnIndex))) {
      throw new SeatRecommendationError("INVALID_SEAT_MAP", "Seat row/column indices must be non-negative integers.", {
        seatId: seat.id
      });
    }
    if (seat.rowIndex !== undefined && seat.columnIndex !== undefined) {
      const position = `${seat.rowIndex}:${seat.columnIndex}`;
      if (positions.has(position)) {
        throw new SeatRecommendationError("INVALID_SEAT_MAP", "Seat layout positions must be unique.", {
          seatId: seat.id,
          rowIndex: seat.rowIndex,
          columnIndex: seat.columnIndex
        });
      }
      positions.add(position);
    }
    if ((seat.x !== undefined && !finiteNumber(seat.x)) || (seat.y !== undefined && !finiteNumber(seat.y))) {
      throw new SeatRecommendationError("INVALID_SEAT_MAP", "Seat coordinates must be finite numbers.", { seatId: seat.id });
    }
  }
}

function recommendationGeometry(seat: CinemaSeat): { row: number; column: number; x: number; y: number } | undefined {
  if (!finiteNonNegativeInteger(seat.rowIndex) || !finiteNonNegativeInteger(seat.columnIndex)) return undefined;
  return {
    row: seat.rowIndex,
    column: seat.columnIndex,
    x: finiteNumber(seat.x) ? seat.x : seat.columnIndex,
    y: finiteNumber(seat.y) ? seat.y : seat.rowIndex
  };
}

function boundaryBreaksAdjacency(left: CinemaSeat, right: CinemaSeat): boolean {
  return left.rightBoundary === "aisle" || left.rightBoundary === "gap" || right.leftBoundary === "aisle" || right.leftBoundary === "gap";
}

function observedGroupMembers(map: CinemaSeatMap): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const seat of map.seats) {
    if (!seat.groupId) continue;
    const members = groups.get(seat.groupId) ?? new Set<string>();
    members.add(seat.id);
    groups.set(seat.groupId, members);
  }
  return groups;
}

function preservesObservedGroups(candidate: CinemaSeat[], groups: Map<string, Set<string>>): boolean {
  const candidateIds = new Set(candidate.map((seat) => seat.id));
  const touched = new Set(candidate.flatMap((seat) => seat.groupId ? [seat.groupId] : []));
  for (const groupId of touched) {
    const members = groups.get(groupId);
    if (!members) continue;
    for (const id of members) {
      if (!candidateIds.has(id)) return false;
    }
  }
  return true;
}

/**
 * Find confirmed-available adjacent groups. Unknown/selected/unavailable seats are
 * deliberately excluded; lack of certainty is never converted into availability.
 */
export function findAdjacentSeatGroups(
  map: CinemaSeatMap,
  count: number,
  options: { preserveGroups?: boolean } = {}
): CinemaSeat[][] {
  assertMapIntegrity(map);
  if (!finiteNonNegativeInteger(count) || count < 1 || count > 8) {
    throw new SeatRecommendationError("INVALID_REQUEST", "Seat count must be an integer from 1 through 8.", { count });
  }

  const byRow = new Map<string, { rowIndex: number; entries: Array<{ seat: CinemaSeat; column: number }> }>();
  for (const seat of map.seats) {
    if (seat.state !== "available") continue;
    const geometry = recommendationGeometry(seat);
    if (!geometry) continue;
    const rowKey = `${geometry.row}|${seat.row ?? ""}`;
    const row = byRow.get(rowKey) ?? { rowIndex: geometry.row, entries: [] };
    row.entries.push({ seat, column: geometry.column });
    byRow.set(rowKey, row);
  }

  const groups = observedGroupMembers(map);
  const preserveGroups = options.preserveGroups !== false;
  const candidates: CinemaSeat[][] = [];
  const rowEntries = [...byRow.values()].sort((a, b) =>
    a.rowIndex - b.rowIndex || compareText(a.entries[0]?.seat.row ?? "", b.entries[0]?.seat.row ?? "")
  );
  for (const { entries } of rowEntries) {
    entries.sort((a, b) => a.column - b.column || compareText(a.seat.id, b.seat.id));
    for (let start = 0; start + count <= entries.length; start += 1) {
      const window = entries.slice(start, start + count);
      let adjacent = true;
      for (let index = 1; index < window.length; index += 1) {
        const left = window[index - 1];
        const right = window[index];
        if (!left || !right || right.column !== left.column + 1 || boundaryBreaksAdjacency(left.seat, right.seat)) {
          adjacent = false;
          break;
        }
      }
      if (!adjacent) continue;
      const seats = window.map((entry) => entry.seat);
      if (preserveGroups && !preservesObservedGroups(seats, groups)) continue;
      candidates.push(seats);
    }
  }
  return candidates;
}

interface AxisRange {
  min: number;
  max: number;
}

function range(values: number[]): AxisRange {
  return { min: Math.min(...values), max: Math.max(...values) };
}

function normalized(value: number, axis: AxisRange): number {
  if (axis.max === axis.min) return 0.5;
  return clamp01((value - axis.min) / (axis.max - axis.min));
}

function groupGeometry(map: CinemaSeatMap, group: CinemaSeat[]): SeatRecommendationScore {
  const allGeometry = map.seats.map(recommendationGeometry).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const geometry = group.map(recommendationGeometry).filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (geometry.length !== group.length || allGeometry.length !== map.seats.length || allGeometry.length === 0) {
    throw new SeatRecommendationError(
      "INVALID_SEAT_MAP",
      "Recommendation scoring requires complete observable row/column geometry for the seat map."
    );
  }

  const xRange = range(allGeometry.map((item) => item.x));
  const yRange = range(allGeometry.map((item) => item.y));
  const edge = map.screenEdge;
  if (!edge) {
    throw new SeatRecommendationError("INVALID_SEAT_MAP", "Screen/front orientation is required for recommendation scoring.");
  }

  const centerScores: number[] = [];
  const rearScores: number[] = [];
  for (const item of geometry) {
    const nx = normalized(item.x, xRange);
    const ny = normalized(item.y, yRange);
    const orthogonal = edge === "top" || edge === "bottom" ? nx : ny;
    const depth = edge === "top" ? ny : edge === "bottom" ? 1 - ny : edge === "left" ? nx : 1 - nx;
    centerScores.push(1 - Math.abs(orthogonal - 0.5) * 2);
    rearScores.push(depth);
  }

  const center = centerScores.reduce((sum, value) => sum + value, 0) / centerScores.length;
  const rear = rearScores.reduce((sum, value) => sum + value, 0) / rearScores.length;
  const first = group[0];
  const last = group[group.length - 1];
  const aisle = first?.leftBoundary === "aisle" || first?.leftBoundary === "gap" ||
    last?.rightBoundary === "aisle" || last?.rightBoundary === "gap" ? 1 : 0;
  return { center: rounded(center), rear: rounded(rear), aisle, total: 0 };
}

function totalFor(preference: SeatPreference, score: SeatRecommendationScore): number {
  switch (preference) {
    case "center": return score.center;
    case "rear": return score.rear;
    case "rear-middle": return (score.center + score.rear) / 2;
    case "aisle": return score.aisle * 0.7 + score.center * 0.2 + score.rear * 0.1;
  }
}

/** Deterministic provider-independent recommendation over normalized rendered seat facts. */
export function recommendSeatGroups(map: CinemaSeatMap, request: SeatRecommendationRequest): SeatGroupRecommendation[] {
  assertMapIntegrity(map);
  if (!finiteNonNegativeInteger(request.count) || request.count < 1 || request.count > 8) {
    throw new SeatRecommendationError("INVALID_REQUEST", "Seat count must be an integer from 1 through 8.", { count: request.count });
  }
  const limit = request.limit ?? 5;
  if (!finiteNonNegativeInteger(limit) || limit < 1 || limit > 20) {
    throw new SeatRecommendationError("INVALID_REQUEST", "Recommendation limit must be an integer from 1 through 20.", { limit });
  }

  const groups = findAdjacentSeatGroups(map, request.count, { preserveGroups: request.preserveGroups });
  const recommendations = groups.map((group): SeatGroupRecommendation => {
    const score = groupGeometry(map, group);
    score.total = rounded(totalFor(request.preference, score));
    return { seatIds: group.map((seat) => seat.id), score };
  });

  return recommendations
    .sort((a, b) =>
      b.score.total - a.score.total ||
      b.score.center - a.score.center ||
      b.score.rear - a.score.rear ||
      compareText(a.seatIds.join("|"), b.seatIds.join("|"))
    )
    .slice(0, limit);
}
