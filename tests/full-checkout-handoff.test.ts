import test from "node:test";
import assert from "node:assert/strict";
import type { SeatAvailabilityResult } from "../src/cinema.js";
import {
  HumanCheckoutHandoffError,
  humanCheckoutHandoffDigest,
  humanCheckoutHandoffIntentSchema,
  validateHumanCheckoutHandoffSeatReads,
  type HumanCheckoutHandoffIntent
} from "../src/full-checkout-handoff.js";

const intent: HumanCheckoutHandoffIntent = {
  provider: "toho",
  showtime: {
    theater: "ららぽーと横浜",
    theaterId: "036",
    date: "2026-09-05",
    movie: "見えない娘 ＴＨＥ ＩＮＶＩＳＩＢＬＥＳ",
    startTime: "09:30",
    screen: "2"
  },
  seatIds: ["A-2", "A-3"]
};

function result(overrides: {
  seatStates?: Record<string, "available" | "unavailable" | "selected" | "unknown">;
  attrs?: Record<string, string[]>;
  observedAt?: string;
  movie?: string;
} = {}): SeatAvailabilityResult<"toho"> {
  const seatStates = overrides.seatStates ?? {};
  const attrs = overrides.attrs ?? {};
  return {
    provider: "toho",
    theater: {
      provider: "toho",
      id: "036",
      name: "ららぽーと横浜",
      sourceUrl: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do"
    },
    showtime: {
      provider: "toho",
      theaterId: "036",
      theater: "ららぽーと横浜",
      date: "2026-09-05",
      movie: overrides.movie ?? "見えない娘 ＴＨＥ ＩＮＶＩＳＩＢＬＥＳ",
      startTime: "09:30",
      formats: [],
      screen: "2",
      availability: "unknown",
      sourceUrl: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do"
    },
    seatMap: {
      provider: "toho",
      theaterId: "036",
      theater: "ららぽーと横浜",
      screen: "2",
      showtimeIdentity: "toho:036:2026-09-05:09:30:2",
      screenEdge: "top",
      observedAt: overrides.observedAt ?? "2026-09-05T00:00:00.000Z",
      sourceUrl: "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do",
      seats: ["A-2", "A-3", "A-4"].map((id, index) => ({
        id,
        row: "A",
        number: id.split("-")[1],
        state: seatStates[id] ?? "available",
        attributes: (attrs[id] ?? []) as never[],
        rowIndex: 0,
        columnIndex: index
      }))
    }
  };
}

test("full checkout Handoff intent is strict, seat-only, and digest is canonical across seat ordering", () => {
  assert.equal(humanCheckoutHandoffIntentSchema.safeParse(intent).success, true);
  assert.equal(humanCheckoutHandoffIntentSchema.safeParse({ ...intent, seatIds: undefined }).success, true);
  assert.equal(humanCheckoutHandoffIntentSchema.safeParse({ ...intent, ticketChoices: [] }).success, false);
  assert.equal(humanCheckoutHandoffIntentSchema.safeParse({ ...intent, seatIds: ["A-2", "A-2"] }).success, false);
  assert.equal(
    humanCheckoutHandoffDigest(intent),
    humanCheckoutHandoffDigest({ ...intent, seatIds: ["A-3", "A-2"] })
  );
});

test("full checkout Handoff requires two stable exact TOHO observations and every intended ordinary seat available", () => {
  const first = result({ observedAt: "2026-09-05T00:00:00.000Z" });
  const second = result({ observedAt: "2026-09-05T00:00:01.000Z" });
  const validated = validateHumanCheckoutHandoffSeatReads(intent, first, second);
  assert.equal(validated.showtimeIdentity, "toho:036:2026-09-05:09:30:2");
  assert.equal(validated.sourceUrl, "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do");

  assert.throws(
    () => validateHumanCheckoutHandoffSeatReads(intent, first, result({ seatStates: { "A-3": "unavailable" } })),
    (error) => error instanceof HumanCheckoutHandoffError && error.code === "STALE_CONTEXT"
  );
  const bothUnavailable = result({ seatStates: { "A-3": "unavailable" } });
  assert.throws(
    () => validateHumanCheckoutHandoffSeatReads(intent, bothUnavailable, bothUnavailable),
    (error) => error instanceof HumanCheckoutHandoffError && error.code === "SEAT_UNAVAILABLE"
  );
});

test("full checkout Handoff leaves special-seat choice to Human and still refuses showtime drift before Human control", () => {
  const special = result({ attrs: { "A-2": ["premium"] } });
  assert.doesNotThrow(() => validateHumanCheckoutHandoffSeatReads(intent, special, special));
  assert.doesNotThrow(() => validateHumanCheckoutHandoffSeatReads({ ...intent, seatIds: undefined }, special, special));
  const drift = result({ movie: "別作品" });
  assert.throws(
    () => validateHumanCheckoutHandoffSeatReads(intent, drift, drift),
    (error) => error instanceof HumanCheckoutHandoffError && error.code === "STALE_CONTEXT"
  );
  const noneAvailable = result({ seatStates: { "A-2": "unavailable", "A-3": "unavailable", "A-4": "unavailable" } });
  assert.throws(
    () => validateHumanCheckoutHandoffSeatReads({ ...intent, seatIds: undefined }, noneAvailable, noneAvailable),
    (error) => error instanceof HumanCheckoutHandoffError && error.code === "SEAT_UNAVAILABLE"
  );

});
