import test from "node:test";
import assert from "node:assert/strict";
import type { CinemaSeat, CinemaSeatMap } from "../src/cinema.js";
import {
  SeatRecommendationError,
  findAdjacentSeatGroups,
  recommendSeatGroups
} from "../src/seat-recommendation.js";

function seat(
  id: string,
  rowIndex: number,
  columnIndex: number,
  state: CinemaSeat["state"] = "available",
  extra: Partial<CinemaSeat> = {}
): CinemaSeat {
  return {
    id,
    row: String.fromCharCode(65 + rowIndex),
    number: String(columnIndex + 1),
    state,
    attributes: [],
    rowIndex,
    columnIndex,
    x: columnIndex,
    y: rowIndex,
    ...extra
  };
}

function map(seats: CinemaSeat[], screenEdge: CinemaSeatMap["screenEdge"] = "top"): CinemaSeatMap<"toho"> {
  return {
    provider: "toho",
    theaterId: "036",
    theater: "TOHOシネマズ ららぽーと横浜",
    screen: "3",
    showtimeIdentity: "036|2026-08-17|21:10|screen-3",
    seats,
    screenEdge,
    observedAt: "2026-08-17T00:00:00+09:00",
    sourceUrl: "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do"
  };
}

test("adjacent grouping only uses confirmed available seats and never treats unknown as available", () => {
  const input = map([
    seat("A-1", 0, 0),
    seat("A-2", 0, 1, "unknown"),
    seat("A-3", 0, 2),
    seat("A-4", 0, 3),
    seat("A-5", 0, 4, "unavailable", { unavailableReason: "sold" })
  ]);
  assert.deepEqual(findAdjacentSeatGroups(input, 2).map((group) => group.map((item) => item.id)), [["A-3", "A-4"]]);
});

test("adjacent grouping respects explicit gap and aisle boundaries plus layout-slot gaps", () => {
  const input = map([
    seat("A-1", 0, 0, "available", { rightBoundary: "aisle" }),
    seat("A-2", 0, 1),
    seat("A-3", 0, 2, "available", { rightBoundary: "gap" }),
    seat("A-5", 0, 4),
    seat("A-6", 0, 5)
  ]);
  assert.deepEqual(findAdjacentSeatGroups(input, 2).map((group) => group.map((item) => item.id)), [["A-2", "A-3"], ["A-5", "A-6"]]);
});


test("adjacent grouping never joins semantic rows that share the same physical depth", () => {
  const input = map([
    seat("C-17", 2, 10, "available", { row: "C" }),
    seat("HC-1", 2, 11, "available", { row: "HC", attributes: ["wheelchair"] }),
    seat("HC-2", 2, 12, "available", { row: "HC", attributes: ["wheelchair"] }),
    seat("C-18", 2, 13, "available", { row: "C" })
  ]);
  assert.deepEqual(findAdjacentSeatGroups(input, 2).map((group) => group.map((item) => item.id)), [["HC-1", "HC-2"]]);
});

test("explicit pair/group identities are not split by default", () => {
  const input = map([
    seat("A-1", 0, 0),
    seat("A-2", 0, 1, "available", { groupId: "pair-1", attributes: ["pair"] }),
    seat("A-3", 0, 2, "available", { groupId: "pair-1", attributes: ["pair"] }),
    seat("A-4", 0, 3)
  ]);
  assert.deepEqual(findAdjacentSeatGroups(input, 1).map((group) => group.map((item) => item.id)), [["A-1"], ["A-4"]]);
  assert.deepEqual(findAdjacentSeatGroups(input, 2).map((group) => group.map((item) => item.id)), [["A-2", "A-3"]]);
  assert.deepEqual(
    findAdjacentSeatGroups(input, 1, { preserveGroups: false }).map((group) => group.map((item) => item.id)),
    [["A-1"], ["A-2"], ["A-3"], ["A-4"]]
  );
});


test("special seat attributes remain independent from availability", () => {
  const input = map([
    seat("A-1", 0, 0, "available", { attributes: ["executive", "premium"] }),
    seat("A-2", 0, 1, "unavailable", { attributes: ["wheelchair"], unavailableReason: "not_for_sale" })
  ]);
  assert.deepEqual(findAdjacentSeatGroups(input, 1).map((group) => group[0]?.id), ["A-1"]);
  assert.deepEqual(input.seats[0]?.attributes, ["executive", "premium"]);
  assert.equal(input.seats[0]?.state, "available");
});

test("center and rear scoring use rendered geometry and screen orientation deterministically", () => {
  const input = map([
    seat("A-1", 0, 0), seat("A-2", 0, 1), seat("A-3", 0, 2), seat("A-4", 0, 3), seat("A-5", 0, 4),
    seat("B-1", 1, 0), seat("B-2", 1, 1), seat("B-3", 1, 2), seat("B-4", 1, 3), seat("B-5", 1, 4),
    seat("C-1", 2, 0), seat("C-2", 2, 1), seat("C-3", 2, 2), seat("C-4", 2, 3), seat("C-5", 2, 4)
  ]);
  assert.deepEqual(recommendSeatGroups(input, { count: 1, preference: "center", limit: 1 })[0]?.seatIds, ["C-3"]);
  assert.deepEqual(recommendSeatGroups(input, { count: 1, preference: "rear", limit: 1 })[0]?.seatIds, ["C-3"]);
  assert.deepEqual(recommendSeatGroups(input, { count: 1, preference: "rear-middle", limit: 1 })[0]?.seatIds, ["C-3"]);
});

test("aisle preference uses only observed outer aisle/gap boundaries", () => {
  const input = map([
    seat("A-1", 0, 0, "available", { leftBoundary: "aisle" }),
    seat("A-2", 0, 1),
    seat("A-3", 0, 2),
    seat("A-4", 0, 3, "available", { rightBoundary: "aisle" })
  ]);
  const result = recommendSeatGroups(input, { count: 1, preference: "aisle", limit: 4 });
  assert.deepEqual(result.slice(0, 2).map((item) => item.seatIds[0]), ["A-1", "A-4"]);
  assert.equal(result[0]?.score.aisle, 1);
  assert.equal(result[2]?.score.aisle, 0);
});

test("screen edge changes rear direction without changing provider seat identity", () => {
  const seats = [seat("A-1", 0, 0), seat("B-1", 1, 0), seat("C-1", 2, 0)];
  assert.deepEqual(recommendSeatGroups(map(seats, "top"), { count: 1, preference: "rear", limit: 1 })[0]?.seatIds, ["C-1"]);
  assert.deepEqual(recommendSeatGroups(map(seats, "bottom"), { count: 1, preference: "rear", limit: 1 })[0]?.seatIds, ["A-1"]);
});

test("recommendation fails closed on duplicate identity, incomplete orientation, and invalid unavailable reason", () => {
  assert.throws(
    () => findAdjacentSeatGroups(map([seat("A-1", 0, 0), seat("A-1", 0, 1)]), 1),
    (error) => error instanceof SeatRecommendationError && error.code === "INVALID_SEAT_MAP"
  );
  const noOrientation = map([seat("A-1", 0, 0)]);
  delete noOrientation.screenEdge;
  assert.throws(
    () => recommendSeatGroups(noOrientation, { count: 1, preference: "center" }),
    (error) => error instanceof SeatRecommendationError && error.code === "INVALID_SEAT_MAP"
  );
  assert.throws(
    () => recommendSeatGroups(map([seat("A-1", 0, 0), { ...seat("A-2", 0, 1), rowIndex: undefined }]), { count: 1, preference: "center" }),
    (error) => error instanceof SeatRecommendationError && error.code === "INVALID_SEAT_MAP"
  );
  assert.throws(
    () => findAdjacentSeatGroups(map([seat("A-1", 0, 0), seat("A-2", 0, 0)]), 1),
    (error) => error instanceof SeatRecommendationError && error.code === "INVALID_SEAT_MAP"
  );
  assert.throws(
    () => findAdjacentSeatGroups(map([seat("A-1", 0, 0, "available", { unavailableReason: "sold" })]), 1),
    (error) => error instanceof SeatRecommendationError && error.code === "INVALID_SEAT_MAP"
  );
});

test("recommendation output is deterministic and bounded", () => {
  const input = map([
    seat("A-1", 0, 0), seat("A-2", 0, 1), seat("A-3", 0, 2), seat("A-4", 0, 3),
    seat("B-1", 1, 0), seat("B-2", 1, 1), seat("B-3", 1, 2), seat("B-4", 1, 3)
  ]);
  const first = recommendSeatGroups(input, { count: 2, preference: "rear-middle", limit: 3 });
  const second = recommendSeatGroups(input, { count: 2, preference: "rear-middle", limit: 3 });
  assert.deepEqual(second, first);
  assert.equal(first.length, 3);
});
