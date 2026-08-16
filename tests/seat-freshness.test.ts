import test from "node:test";
import assert from "node:assert/strict";
import type { CinemaSeat, CinemaSeatMap } from "../src/cinema.js";
import { compareCinemaSeatObservations, fingerprintCinemaSeatMap } from "../src/seat-freshness.js";

function seat(id: string, columnIndex: number, state: CinemaSeat["state"] = "available"): CinemaSeat {
  return {
    id,
    row: "A",
    number: String(columnIndex + 1),
    state,
    ...(state === "unavailable" ? { unavailableReason: "unknown" as const } : {}),
    attributes: [],
    rowIndex: 0,
    columnIndex,
    x: columnIndex,
    y: 0
  };
}

function map(overrides: Partial<CinemaSeatMap> = {}): CinemaSeatMap<"toho"> {
  return {
    provider: "toho",
    theaterId: "036",
    theater: "TOHOシネマズ ららぽーと横浜",
    screen: "3",
    showtimeIdentity: "toho|036|2026-08-17|映画A|21:10|23:05|3",
    seats: [seat("A-1", 0), seat("A-2", 1), seat("A-3", 2, "unavailable")],
    screenEdge: "top",
    observedAt: "2026-08-17T00:00:00.000Z",
    sourceUrl: "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do",
    ...overrides
  };
}

test("seat fingerprints ignore observation timestamp and DOM ordering but preserve facts", () => {
  const first = map();
  const second = map({
    observedAt: "2026-08-17T00:00:02.000Z",
    seats: [...first.seats].reverse()
  });
  assert.deepEqual(fingerprintCinemaSeatMap(second), fingerprintCinemaSeatMap(first));
  assert.deepEqual(compareCinemaSeatObservations(first, second).change, "none");
});

test("seat freshness distinguishes context, layout, and availability changes", () => {
  const baseline = map();
  const context = map({ screen: "4", showtimeIdentity: "toho|036|2026-08-17|映画A|21:10|23:05|4" });
  const layout = map({ seats: baseline.seats.map((item) => item.id === "A-2" ? { ...item, columnIndex: 3, x: 3 } : item) });
  const state = map({ seats: baseline.seats.map((item) => item.id === "A-2" ? { ...item, state: "unavailable", unavailableReason: "unknown" as const } : item) });

  assert.equal(compareCinemaSeatObservations(baseline, context).change, "context");
  assert.equal(compareCinemaSeatObservations(baseline, layout).change, "layout");
  assert.equal(compareCinemaSeatObservations(baseline, state).change, "state");
});
