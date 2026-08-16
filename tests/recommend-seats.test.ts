import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError } from "../src/browser/runtime.js";
import type {
  CinemaSeat,
  CinemaSeatMap,
  CinemaSeatReadAdapter,
  SeatAvailabilityResult
} from "../src/cinema.js";
import { recommendSeats } from "../src/recommend-seats.js";

function seat(id: string, rowIndex: number, columnIndex: number, state: CinemaSeat["state"] = "available"): CinemaSeat {
  return {
    id,
    row: String.fromCharCode(65 + rowIndex),
    number: String(columnIndex + 1),
    state,
    ...(state === "unavailable" ? { unavailableReason: "unknown" as const } : {}),
    attributes: [],
    rowIndex,
    columnIndex,
    x: columnIndex,
    y: rowIndex
  };
}

function result(observedAt: string, seats?: CinemaSeat[]): SeatAvailabilityResult<"toho"> {
  const theater = {
    provider: "toho" as const,
    id: "036",
    name: "TOHOシネマズ ららぽーと横浜",
    aliases: ["TOHOシネマズ ららぽーと横浜"],
    url: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do",
    sourceUrl: "https://www.tohotheater.jp/theater/find.html"
  };
  const showtime = {
    provider: "toho" as const,
    theaterId: "036",
    theater: theater.name,
    date: "2026-08-17",
    movie: "映画A",
    startTime: "21:10",
    endTime: "23:05",
    formats: [],
    screen: "3",
    availability: "unknown" as const,
    sourceUrl: theater.url
  };
  const seatMap: CinemaSeatMap<"toho"> = {
    provider: "toho",
    theaterId: theater.id,
    theater: theater.name,
    screen: showtime.screen,
    showtimeIdentity: "toho|036|2026-08-17|映画A|21:10|23:05|3",
    seats: seats ?? [
      seat("A-1", 0, 0), seat("A-2", 0, 1), seat("A-3", 0, 2),
      seat("B-1", 1, 0), seat("B-2", 1, 1), seat("B-3", 1, 2)
    ],
    screenEdge: "top",
    observedAt,
    sourceUrl: "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do"
  };
  return { provider: "toho", theater, showtime, seatMap };
}

function queuedAdapter(values: SeatAvailabilityResult[]): { adapter: CinemaSeatReadAdapter; calls: () => number } {
  let count = 0;
  return {
    adapter: {
      getSeatAvailability: async () => {
        const value = values[count];
        count += 1;
        if (!value) throw new Error("unexpected extra seat read");
        return value;
      }
    },
    calls: () => count
  };
}

const query = {
  provider: "toho" as const,
  theater: "ららぽーと横浜",
  date: "2026-08-17",
  movie: "映画A",
  startTime: "21:10",
  screen: "3",
  count: 2,
  preference: "rear-middle" as const,
  limit: 3
};

test("recommend_seats uses exactly two stable read-only observations and scores only the verified second map", async () => {
  const first = result("2026-08-17T00:00:00.000Z");
  const second = result("2026-08-17T00:00:02.000Z");
  const fake = queuedAdapter([first, second]);
  const output = await recommendSeats(query, fake.adapter);

  assert.equal(fake.calls(), 2);
  assert.equal(output.status, "recommended");
  assert.equal(output.freshness.firstObservedAt, first.seatMap.observedAt);
  assert.equal(output.freshness.verifiedAt, second.seatMap.observedAt);
  assert.equal(output.recommendations.length, 3);
  assert.deepEqual(output.recommendations[0]?.seatIds, ["B-1", "B-2"]);
  assert.equal(output.availableSeatCount, 6);
});

test("recommend_seats fails closed when availability changes between observations", async () => {
  const first = result("2026-08-17T00:00:00.000Z");
  const changed = result("2026-08-17T00:00:02.000Z", first.seatMap.seats.map((item) =>
    item.id === "B-2" ? { ...item, state: "unavailable", unavailableReason: "unknown" as const } : item
  ));
  const fake = queuedAdapter([first, changed]);

  await assert.rejects(
    recommendSeats(query, fake.adapter),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && error.details?.reason === "seat_state_changed"
  );
  assert.equal(fake.calls(), 2);
});

test("recommend_seats fails closed when showtime context changes between observations", async () => {
  const first = result("2026-08-17T00:00:00.000Z");
  const changed = result("2026-08-17T00:00:02.000Z");
  changed.theater = { ...changed.theater, id: "999" };
  changed.showtime = { ...changed.showtime, theaterId: "999" };
  changed.seatMap = { ...changed.seatMap, theaterId: "999", showtimeIdentity: "toho|999|2026-08-17|映画A|21:10|23:05|3" };
  const fake = queuedAdapter([first, changed]);

  await assert.rejects(
    recommendSeats(query, fake.adapter),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && error.details?.reason === "seat_context_changed"
  );
});

test("recommend_seats explicitly reports when no confirmed adjacent group exists", async () => {
  const seats = [seat("A-1", 0, 0), seat("A-3", 0, 2), seat("B-1", 1, 0, "unknown"), seat("B-2", 1, 1)];
  const first = result("2026-08-17T00:00:00.000Z", seats);
  const second = result("2026-08-17T00:00:02.000Z", seats.map((item) => ({ ...item })));
  const fake = queuedAdapter([first, second]);
  const output = await recommendSeats(query, fake.adapter);

  assert.equal(output.status, "no_confirmed_adjacent_group");
  assert.deepEqual(output.recommendations, []);
  assert.equal(output.availableSeatCount, 3);
});


test("recommend_seats rejects an adapter result that does not match the requested showtime", async () => {
  const wrong = result("2026-08-17T00:00:00.000Z");
  wrong.showtime = { ...wrong.showtime, startTime: "20:00" };
  const fake = queuedAdapter([wrong]);
  await assert.rejects(
    recommendSeats(query, fake.adapter),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && error.details?.reason === "seat_context_invalid"
  );
  assert.equal(fake.calls(), 1);
});
