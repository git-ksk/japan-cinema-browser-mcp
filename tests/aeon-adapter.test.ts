import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import {
  AeonReadAdapter,
  buildAeonScheduleUrl,
  normalizeAeonScheduleSnapshot,
  normalizeAeonTheaterQuery,
  normalizeAeonTheaterSnapshot
} from "../src/providers/aeon/adapter.js";

interface TheaterRowFixture {
  label: string;
  href: string;
  route?: string;
  code?: string;
  area?: string;
}

function theaterRows(count = 55): TheaterRowFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `テスト劇場${index + 1}${index % 2 === 0 ? " IMAXレーザー" : " ULTIRA D-BOX"}`,
    href: `https://theater.aeoncinema.com/theaters/test-${index + 1}/`
  }));
}

function hakusanTheater() {
  return {
    provider: "aeon" as const,
    id: "hakusan",
    name: "イオンシネマ 白山",
    sourceUrl: "https://www.aeoncinema.com/theater/",
    scheduleUrl: "https://theater.aeoncinema.com/theaters/hakusan/",
    selectionLabel: "白山 GRAN THEATER ULTILA Dolby Atmos"
  };
}

test("AEON theater snapshot normalizes visible labels and adopts only explicit reviewed public schedule routes", () => {
  const rows = theaterRows();
  rows.push({
    label: "悪性lookalike",
    href: "https://evil-aeoncinema.com/theaters/evil/"
  });
  rows.push({
    label: "URL未確定劇場",
    href: "",
    code: "must-not-be-guessed"
  });
  const result = normalizeAeonTheaterSnapshot(
    { headingCount: 1, rows },
    "https://www.aeoncinema.com/theater/"
  );
  assert.equal(result.length, 57);
  assert.equal(result[0]?.provider, "aeon");
  const first = result.find((theater) => theater.id === "test-1");
  assert.equal(first?.name, "イオンシネマ テスト劇場1");
  assert.equal(first?.scheduleUrl, "https://theater.aeoncinema.com/theaters/test-1/");
  assert.equal(result.find((theater) => theater.name.includes("悪性lookalike"))?.scheduleUrl, undefined);
  assert.equal(result.find((theater) => theater.name.includes("URL未確定劇場"))?.scheduleUrl, undefined);
});

test("AEON current public /cinema links remain navigation-only and never become guessed schedule routes", () => {
  const rows = theaterRows(54);
  rows.push({
    label: "みなとみらい 4DX",
    href: "https://www.aeoncinema.com/cinema/minatomirai/"
  });
  const result = normalizeAeonTheaterSnapshot(
    { headingCount: 1, rows },
    "https://www.aeoncinema.com/theater/"
  );
  const theater = result.find((candidate) => candidate.name === "イオンシネマ みなとみらい");

  assert.ok(theater);
  assert.equal(theater?.selectionLabel, "みなとみらい 4DX");
  assert.equal(theater?.scheduleUrl, undefined);
  assert.equal(theater?.id, "みなとみらい");
});

test("AEON theater snapshot fails closed when the public theater list shape collapses", () => {
  assert.throws(
    () => normalizeAeonTheaterSnapshot(
      { headingCount: 1, rows: theaterRows(8) },
      "https://www.aeoncinema.com/theater/"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("AEON schedule URL uses only the reviewed public theater route and a valid calendar date", () => {
  assert.equal(
    buildAeonScheduleUrl("https://theater.aeoncinema.com/theaters/hakusan/", "2026-08-14"),
    "https://theater.aeoncinema.com/theaters/hakusan/?date=20260814"
  );
  assert.throws(
    () => buildAeonScheduleUrl("https://theater.aeoncinema.com/theaters/hakusan/", "2026-02-31"),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => buildAeonScheduleUrl("https://evil.aeoncinema.com.evil.example/theaters/hakusan/", "2026-08-14"),
    (error) => error instanceof BrowserRuntimeError && error.code === "URL_NOT_ALLOWED"
  );
});

test("AEON schedule snapshot returns compact movie/showtime facts without treating reservation controls as actions", () => {
  const showtimes = normalizeAeonScheduleSnapshot(
    {
      title: "上映スケジュール｜白山｜イオンシネマ",
      scheduleHeadingCount: 1,
      theaterNames: ["イオンシネマ 白山"],
      ambiguousTimeGroups: 0,
      showtimes: [
        {
          movie: "FouRTe Project 1st LIVE ALL IN",
          label: "18:30~21:00",
          context: "FouRTe Project 1st LIVE ALL IN 4DX ULTILA 字幕 18:30~21:00 スクリーン9 予約購入"
        }
      ],
      emptySchedule: false
    },
    hakusanTheater(),
    "2026-08-14",
    "https://theater.aeoncinema.com/theaters/hakusan/?date=20260814"
  );
  assert.equal(showtimes.length, 1);
  assert.equal(showtimes[0]?.movie, "FouRTe Project 1st LIVE ALL IN");
  assert.equal(showtimes[0]?.startTime, "18:30");
  assert.equal(showtimes[0]?.endTime, "21:00");
  assert.equal(showtimes[0]?.screen, "9");
  assert.equal(showtimes[0]?.language, "subtitled");
  assert.deepEqual(showtimes[0]?.formats, ["4DX", "ULTIRA"]);
  assert.equal(showtimes[0]?.availability, "unknown");
});

test("AEON schedule snapshot refuses partial results when a time range has no movie identity", () => {
  assert.throws(
    () => normalizeAeonScheduleSnapshot(
      {
        title: "上映スケジュール｜白山｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 白山"],
        ambiguousTimeGroups: 0,
        showtimes: [{ movie: "", label: "18:30~21:00", context: "スクリーン9 予約購入" }],
        emptySchedule: false
      },
      hakusanTheater(),
      "2026-08-14",
      "https://theater.aeoncinema.com/theaters/hakusan/?date=20260814"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("AEON schedule snapshot fails closed when one rendered group contains multiple inseparable time ranges", () => {
  assert.throws(
    () => normalizeAeonScheduleSnapshot(
      {
        title: "上映スケジュール｜白山｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 白山"],
        ambiguousTimeGroups: 1,
        showtimes: [],
        emptySchedule: false
      },
      hakusanTheater(),
      "2026-08-14",
      "https://theater.aeoncinema.com/theaters/hakusan/?date=20260814"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("AEON dateAvailable remains a date-level fact when a movie filter matches no showtimes", async () => {
  const rows = theaterRows();
  rows[0] = {
    label: "白山 GRAN THEATER ULTILA Dolby Atmos",
    href: "https://theater.aeoncinema.com/theaters/hakusan/"
  };
  const states = [
    {
      url: "https://www.aeoncinema.com/theater/",
      value: { headingCount: 1, rows }
    },
    {
      url: "https://theater.aeoncinema.com/theaters/hakusan/?date=20260815",
      value: {
        title: "上映スケジュール｜白山｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 白山"],
        dateLabels: ["8/15（土）", "8/16（日）"],
        ambiguousTimeGroups: 0,
        showtimes: [
          {
            movie: "実在する作品",
            label: "10:00~12:00",
            context: "実在する作品 10:00~12:00 スクリーン1"
          }
        ],
        emptySchedule: false
      }
    }
  ];
  let index = 0;
  const runtime = {
    status: async () => ({
      connected: true,
      url: "https://www.aeoncinema.com/theater/",
      provider: "aeon",
      officialSurface: true
    }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => {
      const state = states[index++];
      if (!state) throw new Error("fake semantic state exhausted");
      return state;
    },
    clickReviewedControl: async () => ({ clicked: true })
  } as unknown as CinemaBrowserRuntime;

  const result = await new AeonReadAdapter(runtime).getShowtimes({
    theater: "白山",
    date: "2026-08-15",
    movie: "存在しない作品"
  });

  assert.equal(result.dateAvailable, true);
  assert.deepEqual(result.showtimes, []);
  assert.ok(result.availableDates.includes("2026-08-15"));
});


test("AEON theater query normalizes width/spacing and searches only rendered area context", async () => {
  assert.equal(normalizeAeonTheaterQuery(" イオン　シネマ 港北ニュータウン "), "港北ニュータウン");

  const rows = theaterRows();
  rows[0] = {
    label: "港北ニュータウン ULTILA D-BOX",
    href: "https://www.aeoncinema.com/cinema/kohoku/",
    area: "神奈川"
  };
  rows[1] = {
    label: "みなとみらい 4DX",
    href: "https://www.aeoncinema.com/cinema/minatomirai/",
    area: "神奈川"
  };
  for (let index = 2; index < rows.length; index += 1) rows[index]!.area = "北海道";

  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => ({
      url: "https://www.aeoncinema.com/theater/",
      value: { headingCount: 1, rows }
    }),
    clickReviewedControl: async () => ({ clicked: true })
  } as unknown as CinemaBrowserRuntime;
  const adapter = new AeonReadAdapter(runtime);

  const normalized = await adapter.listTheaters("イオン　シネマ 港北ニュータウン");
  assert.deepEqual(normalized.theaters.map((theater) => theater.name), ["イオンシネマ 港北ニュータウン"]);

  const locality = await adapter.listTheaters("神奈川");
  assert.deepEqual(locality.theaters.map((theater) => theater.name).sort(), ["イオンシネマ みなとみらい", "イオンシネマ 港北ニュータウン"].sort());

  const unsupportedInference = await adapter.listTheaters("横浜");
  assert.deepEqual(unsupportedInference.theaters, [], "do not infer city aliases not present in the public theater list");
});
