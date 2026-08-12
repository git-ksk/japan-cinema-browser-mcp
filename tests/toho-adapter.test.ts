import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import {
  TohoReadAdapter,
  normalizeTohoDateLabel,
  normalizeTohoTheaterSnapshot
} from "../src/providers/toho/adapter.js";

const THEATER_LIST_URL = "https://www.tohotheater.jp/theater/find.html";

function theaterRows(count = 20) {
  return Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return {
      id,
      name: `TOHOシネマズ テスト${index + 1}`,
      url: `https://hlo.tohotheater.jp/net/schedule/${id}/TNPI2000J01.do`
    };
  });
}

function fakeRuntime(states: Array<{ url: string; value: unknown }>): CinemaBrowserRuntime {
  let index = 0;
  const runtime = {
    status: async () => ({ connected: true, url: THEATER_LIST_URL, provider: "toho", officialSurface: true }),
    navigate: async (url: string) => url,
    evaluateSemanticState: async () => {
      const state = states[index++];
      if (!state) throw new Error("fake semantic state exhausted");
      return state;
    },
    clickControl: async () => ({ clicked: true })
  };
  return runtime as unknown as CinemaBrowserRuntime;
}

test("TOHO date labels normalize to Japan calendar dates including year rollover", () => {
  assert.equal(normalizeTohoDateLabel("8/13（木）", "2026-08-13"), "2026-08-13");
  assert.equal(normalizeTohoDateLabel("2026年8月15日", "2026-08-13"), "2026-08-15");
  assert.equal(normalizeTohoDateLabel("1/2（金）", "2026-12-30"), "2027-01-02");
  assert.equal(normalizeTohoDateLabel("2026年2月31日", "2026-02-01"), undefined);
  assert.equal(normalizeTohoDateLabel("not a date", "2026-08-13"), undefined);
});

test("TOHO theater snapshot reuses the official URL guard and deduplicates identical rows", () => {
  const rows = theaterRows();
  rows.push({ ...rows[0]! });
  rows.push({
    id: "997",
    name: "TOHOシネマズ credentialed",
    url: "https://user:pass@hlo.tohotheater.jp/net/schedule/997/TNPI2000J01.do"
  });
  rows.push({
    id: "998",
    name: "TOHOシネマズ non-default-port",
    url: "https://hlo.tohotheater.jp:8443/net/schedule/998/TNPI2000J01.do"
  });
  rows.push({
    id: "999",
    name: "TOHOシネマズ lookalike",
    url: "https://eviltohotheater.jp/net/schedule/999/TNPI2000J01.do"
  });
  const result = normalizeTohoTheaterSnapshot({ rows }, THEATER_LIST_URL);
  assert.equal(result.length, 20);
  assert.equal(result[0]?.provider, "toho");
  assert.ok(result.every((theater) => new URL(theater.url).hostname.endsWith(".tohotheater.jp")));
});

test("TOHO theater snapshot groups multiple visible theater aliases sharing one reviewed schedule route", () => {
  const rows = theaterRows();
  rows.push({
    id: "001",
    name: "TOHOシネマズ 別館",
    url: "https://hlo.tohotheater.jp/net/schedule/001/TNPI2000J01.do"
  });
  const result = normalizeTohoTheaterSnapshot({ rows }, THEATER_LIST_URL);
  const grouped = result.find((theater) => theater.id === "001");
  assert.equal(result.length, 20);
  assert.deepEqual(grouped?.aliases, ["TOHOシネマズ テスト1", "TOHOシネマズ 別館"].sort((a, b) => a.localeCompare(b, "ja")));
  assert.ok(grouped?.name.includes(" / "));
});

test("TOHO theater snapshot fails closed when the public UI no longer resembles a theater list", () => {
  assert.throws(
    () => normalizeTohoTheaterSnapshot({ rows: theaterRows(4) }, THEATER_LIST_URL),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("TOHO showtime normalization returns compact semantic facts and does not mistake SCREEN X for a screen number", async () => {
  const rows = theaterRows();
  const scheduleUrl = rows[0]!.url;
  const runtime = fakeRuntime([
    { url: THEATER_LIST_URL, value: { rows } },
    {
      url: scheduleUrl,
      value: {
        theaterNames: ["TOHOシネマズ テスト1"],
        scheduleHeadingCount: 1,
        dates: [{ label: "2026年8月13日", selected: true, clickable: false }],
        showtimes: [
          {
            label: "10:00 ～ 12:05",
            titleCandidates: ["映画A"],
            context: "IMAXレーザー 字幕 スクリーン 7 残席わずか"
          },
          {
            label: "13:00 販売開始 12:00",
            titleCandidates: ["映画B"],
            context: "SCREEN X"
          }
        ],
        emptySchedule: false
      }
    }
  ]);
  const adapter = new TohoReadAdapter(runtime);
  const result = await adapter.getShowtimes({ theater: "テスト1" });

  assert.equal(result.date, "2026-08-13");
  assert.equal(result.showtimes.length, 2);
  assert.deepEqual(result.showtimes[0], {
    provider: "toho",
    theaterId: "001",
    theater: "TOHOシネマズ テスト1",
    date: "2026-08-13",
    movie: "映画A",
    startTime: "10:00",
    endTime: "12:05",
    formats: ["IMAX LASER"],
    language: "subtitled",
    screen: "7",
    availability: "limited",
    sourceUrl: scheduleUrl
  });
  assert.equal(result.showtimes[1]?.startTime, "13:00");
  assert.equal(result.showtimes[1]?.endTime, undefined);
  assert.deepEqual(result.showtimes[1]?.formats, ["SCREEN X"]);
  assert.equal(result.showtimes[1]?.screen, undefined);
});

test("TOHO showtime normalization fails closed when a visible showtime cannot be tied to a movie", async () => {
  const rows = theaterRows();
  const scheduleUrl = rows[0]!.url;
  const runtime = fakeRuntime([
    { url: THEATER_LIST_URL, value: { rows } },
    {
      url: scheduleUrl,
      value: {
        theaterNames: ["TOHOシネマズ テスト1"],
        scheduleHeadingCount: 1,
        dates: [{ label: "2026年8月13日", selected: true, clickable: false }],
        showtimes: [{ label: "10:00 ～ 12:05", titleCandidates: [], context: "IMAX" }],
        emptySchedule: false
      }
    }
  ]);
  const adapter = new TohoReadAdapter(runtime);

  await assert.rejects(
    () => adapter.getShowtimes({ theater: "テスト1" }),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("TOHO verifies theater route and identity before returning an unavailable date", async () => {
  const rows = theaterRows();
  const wrongScheduleUrl = rows[1]!.url;
  const runtime = fakeRuntime([
    { url: THEATER_LIST_URL, value: { rows } },
    {
      url: wrongScheduleUrl,
      value: {
        theaterNames: ["TOHOシネマズ テスト1"],
        scheduleHeadingCount: 1,
        dates: [{ label: "2026年8月13日", selected: true, clickable: false }],
        showtimes: [],
        emptySchedule: true
      }
    }
  ]);
  const adapter = new TohoReadAdapter(runtime);

  await assert.rejects(
    () => adapter.getShowtimes({ theater: "テスト1", date: "2026-08-14" }),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});
