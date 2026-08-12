import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError } from "../src/browser/runtime.js";
import {
  buildAeonScheduleUrl,
  normalizeAeonScheduleSnapshot,
  normalizeAeonTheaterSnapshot
} from "../src/providers/aeon/adapter.js";

function theaterRows(count = 55) {
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
          context: "FouRTe Project 1st LIVE ALL IN 4DX 字幕 18:30~21:00 スクリーン9 予約購入"
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
  assert.deepEqual(showtimes[0]?.formats, ["4DX"]);
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
