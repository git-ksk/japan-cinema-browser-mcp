import { createHash } from "node:crypto";
import type { CinemaSeat, CinemaSeatMap } from "./cinema.js";

export interface CinemaSeatFingerprints {
  algorithm: "sha256";
  context: string;
  layout: string;
  state: string;
}

export type CinemaSeatObservationChange = "context" | "layout" | "state" | "none";

export interface CinemaSeatFreshnessComparison {
  stable: boolean;
  change: CinemaSeatObservationChange;
  first: CinemaSeatFingerprints;
  second: CinemaSeatFingerprints;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sortedAttributes(seat: CinemaSeat): string[] {
  return [...seat.attributes].sort(compareText);
}

function orderedSeats(map: CinemaSeatMap): CinemaSeat[] {
  return [...map.seats].sort((left, right) => compareText(left.id, right.id));
}

function contextFacts(map: CinemaSeatMap): Record<string, unknown> {
  return {
    provider: map.provider,
    theaterId: map.theaterId,
    theater: map.theater ?? null,
    screen: map.screen ?? null,
    showtimeIdentity: map.showtimeIdentity,
    sourceUrl: map.sourceUrl
  };
}

function layoutFacts(map: CinemaSeatMap): Record<string, unknown> {
  return {
    ...contextFacts(map),
    screenEdge: map.screenEdge ?? null,
    seats: orderedSeats(map).map((seat) => ({
      id: seat.id,
      row: seat.row ?? null,
      number: seat.number ?? null,
      attributes: sortedAttributes(seat),
      rowIndex: seat.rowIndex ?? null,
      columnIndex: seat.columnIndex ?? null,
      x: seat.x ?? null,
      y: seat.y ?? null,
      leftBoundary: seat.leftBoundary ?? null,
      rightBoundary: seat.rightBoundary ?? null,
      groupId: seat.groupId ?? null
    }))
  };
}

function stateFacts(map: CinemaSeatMap): Record<string, unknown> {
  return {
    ...contextFacts(map),
    seats: orderedSeats(map).map((seat) => ({
      id: seat.id,
      state: seat.state,
      unavailableReason: seat.unavailableReason ?? null
    }))
  };
}

/**
 * Deterministic fingerprints intentionally exclude observedAt. Two fresh reads of
 * the same rendered facts must hash identically even though their timestamps differ.
 */
export function fingerprintCinemaSeatMap(map: CinemaSeatMap): CinemaSeatFingerprints {
  return {
    algorithm: "sha256",
    context: sha256(contextFacts(map)),
    layout: sha256(layoutFacts(map)),
    state: sha256(stateFacts(map))
  };
}

export function compareCinemaSeatObservations(
  firstMap: CinemaSeatMap,
  secondMap: CinemaSeatMap
): CinemaSeatFreshnessComparison {
  const first = fingerprintCinemaSeatMap(firstMap);
  const second = fingerprintCinemaSeatMap(secondMap);
  const change: CinemaSeatObservationChange = first.context !== second.context
    ? "context"
    : first.layout !== second.layout
      ? "layout"
      : first.state !== second.state
        ? "state"
        : "none";
  return { stable: change === "none", change, first, second };
}
