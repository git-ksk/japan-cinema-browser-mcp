import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError } from "../src/browser/runtime.js";
import type { CinemaReadAdapter, CinemaShowtime, ShowtimeResult } from "../src/cinema.js";
import { findShowtimes } from "../src/find-showtimes.js";
import type { CinemaProviderId } from "../src/providers.js";

function providerUrls(provider: CinemaProviderId): { theater: string; schedule: string } {
  if (provider === "toho") {
    return {
      theater: "https://www.tohotheater.jp/theater/find.html",
      schedule: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do"
    };
  }
  if (provider === "aeon") {
    return {
      theater: "https://www.aeoncinema.com/theater/",
      schedule: "https://theater.aeoncinema.com/theaters/minatomirai/?date=20260815"
    };
  }
  return {
    theater: "https://109cinemas.net/",
    schedule: "https://109cinemas.net/kohoku/schedules/20260815.html"
  };
}

function result(provider: CinemaProviderId, theaterId: string, theater: string, date: string, showtimes: CinemaShowtime[]): ShowtimeResult {
  const urls = providerUrls(provider);
  return {
    provider,
    theater: {
      provider,
      id: theaterId,
      name: theater,
      sourceUrl: urls.theater
    },
    date,
    dateAvailable: true,
    availableDates: [date],
    sourceUrl: urls.schedule,
    showtimes
  };
}

function showtime(
  provider: CinemaProviderId,
  theaterId: string,
  theater: string,
  date: string,
  startTime: string,
  movie = "テスト作品",
  formats: CinemaShowtime["formats"] = []
): CinemaShowtime {
  const urls = providerUrls(provider);
  return {
    provider,
    theaterId,
    theater,
    date,
    movie,
    startTime,
    formats,
    availability: "unknown",
    sourceUrl: urls.schedule
  };
}

function adapterReturning(value: ShowtimeResult, hooks?: { enter?: () => void; exit?: () => void }): CinemaReadAdapter {
  return {
    listTheaters: async () => ({ provider: value.provider, sourceUrl: value.theater.sourceUrl, theaters: [value.theater] }),
    getShowtimes: async () => {
      hooks?.enter?.();
      await new Promise((resolve) => setTimeout(resolve, 4));
      hooks?.exit?.();
      return value;
    }
  };
}

test("find_showtimes keeps one shared browser workflow sequential and ranks results deterministically", async () => {
  const date = "2026-08-15";
  let active = 0;
  let maxActive = 0;
  const hooks = {
    enter: () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    },
    exit: () => {
      active -= 1;
    }
  };
  const adapters = new Map<CinemaProviderId, CinemaReadAdapter>([
    ["toho", adapterReturning(result("toho", "036", "TOHOシネマズ ららぽーと横浜", date, [
      showtime("toho", "036", "TOHOシネマズ ららぽーと横浜", date, "14:00", "作品B", ["IMAX"]),
      showtime("toho", "036", "TOHOシネマズ ららぽーと横浜", date, "10:00", "作品A")
    ]), hooks)],
    ["109", adapterReturning(result("109", "kohoku", "109シネマズ港北", date, [
      showtime("109", "kohoku", "109シネマズ港北", date, "12:00", "作品C", ["IMAX"])
    ]), hooks)]
  ]);

  const found = await findShowtimes(
    {
      targets: [
        { provider: "toho", theater: "ららぽーと横浜" },
        { provider: "109", theater: "港北" }
      ],
      date
    },
    (provider) => adapters.get(provider)!
  );

  assert.equal(found.complete, true);
  assert.equal(found.failures.length, 0);
  assert.equal(found.successes.length, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(found.showtimes.map((item) => item.startTime), ["10:00", "12:00", "14:00"]);
});

test("find_showtimes exposes provider failure without hiding successful partial results", async () => {
  const date = "2026-08-15";
  const success = adapterReturning(result("toho", "036", "TOHOシネマズ ららぽーと横浜", date, [
    showtime("toho", "036", "TOHOシネマズ ららぽーと横浜", date, "10:00")
  ]));
  const failure = {
    listTheaters: async () => ({ provider: "aeon" as const, sourceUrl: "https://www.aeoncinema.com/theater/", theaters: [] }),
    getShowtimes: async () => {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule shape changed", { marker: "fixture" });
    }
  } as CinemaReadAdapter;

  const found = await findShowtimes(
    {
      targets: [
        { provider: "toho", theater: "ららぽーと横浜" },
        { provider: "aeon", theater: "みなとみらい" }
      ],
      date
    },
    (provider) => provider === "toho" ? success : failure
  );

  assert.equal(found.complete, false);
  assert.equal(found.successes.length, 1);
  assert.equal(found.failures.length, 1);
  assert.equal(found.failures[0]?.target.provider, "aeon");
  assert.equal(found.failures[0]?.error.code, "UI_STATE_CHANGED");
  assert.deepEqual(found.failures[0]?.error.details, { marker: "fixture" });
  assert.equal(found.showtimes.length, 1);
});

test("find_showtimes applies common time and format filters after provider reads", async () => {
  const date = "2026-08-15";
  const adapter = adapterReturning(result("109", "kohoku", "109シネマズ港北", date, [
    showtime("109", "kohoku", "109シネマズ港北", date, "09:30", "朝作品", ["IMAX"]),
    showtime("109", "kohoku", "109シネマズ港北", date, "12:00", "昼作品", ["IMAX"]),
    showtime("109", "kohoku", "109シネマズ港北", date, "15:00", "午後作品", ["4DX"]),
    showtime("109", "kohoku", "109シネマズ港北", date, "18:00", "夜作品", ["IMAX"])
  ]));

  const found = await findShowtimes(
    {
      targets: [{ provider: "109", theater: "港北" }],
      date,
      after: "10:00",
      before: "17:00",
      format: "IMAX"
    },
    () => adapter
  );

  assert.deepEqual(found.showtimes.map((item) => item.startTime), ["12:00"]);
  assert.deepEqual(found.successes[0]?.result.showtimes.map((item) => item.startTime), ["12:00"]);
});

test("find_showtimes rejects a provider result that violates the common identity contract", async () => {
  const date = "2026-08-15";
  const malformed = result("aeon", "minatomirai", "イオンシネマ みなとみらい", date, [
    showtime("aeon", "minatomirai", "イオンシネマ みなとみらい", date, "10:00")
  ]);
  const adapter = adapterReturning(malformed);

  const found = await findShowtimes(
    { targets: [{ provider: "toho", theater: "ららぽーと横浜" }], date },
    () => adapter
  );

  assert.equal(found.complete, false);
  assert.equal(found.successes.length, 0);
  assert.equal(found.showtimes.length, 0);
  assert.equal(found.failures[0]?.error.code, "CONTRACT_VIOLATION");
});


test("find_showtimes rejects result provenance outside the target provider domain", async () => {
  const date = "2026-08-15";
  const malformed = result("toho", "036", "TOHOシネマズ ららぽーと横浜", date, [
    showtime("toho", "036", "TOHOシネマズ ららぽーと横浜", date, "10:00")
  ]);
  malformed.sourceUrl = "https://example.com/schedule";

  const found = await findShowtimes(
    { targets: [{ provider: "toho", theater: "ららぽーと横浜" }], date },
    () => adapterReturning(malformed)
  );

  assert.equal(found.complete, false);
  assert.equal(found.showtimes.length, 0);
  assert.equal(found.failures[0]?.error.code, "CONTRACT_VIOLATION");
  assert.match(found.failures[0]?.error.message ?? "", /provenance/);
});

test("find_showtimes resolves one Tokyo date per request and forwards the same movie query to every target", async () => {
  const observed: Array<{ provider: CinemaProviderId; date?: string; movie?: string }> = [];
  const makeAdapter = (provider: CinemaProviderId, theaterId: string, theater: string): CinemaReadAdapter => ({
    listTheaters: async () => ({
      provider,
      sourceUrl: providerUrls(provider).theater,
      theaters: [{ provider, id: theaterId, name: theater, sourceUrl: providerUrls(provider).theater }]
    }),
    getShowtimes: async (query) => {
      observed.push({ provider, date: query.date, movie: query.movie });
      const date = query.date!;
      return result(provider, theaterId, theater, date, [showtime(provider, theaterId, theater, date, "10:00", "対象作品")]);
    }
  });
  const adapters = new Map<CinemaProviderId, CinemaReadAdapter>([
    ["toho", makeAdapter("toho", "036", "TOHOシネマズ ららぽーと横浜")],
    ["109", makeAdapter("109", "kohoku", "109シネマズ港北")]
  ]);

  const found = await findShowtimes(
    {
      targets: [
        { provider: "toho", theater: "ららぽーと横浜" },
        { provider: "109", theater: "港北" }
      ],
      movie: "対象作品"
    },
    (provider) => adapters.get(provider)!,
    new Date("2026-08-14T15:30:00Z")
  );

  assert.equal(found.date, "2026-08-15");
  assert.deepEqual(observed, [
    { provider: "toho", date: "2026-08-15", movie: "対象作品" },
    { provider: "109", date: "2026-08-15", movie: "対象作品" }
  ]);
});
