import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import {
  TohoReadAdapter,
  normalizeTohoDateLabel,
  normalizeTohoSeatSnapshot,
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
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => {
      const state = states[index++];
      if (!state) throw new Error("fake semantic state exhausted");
      return state;
    },
    clickReviewedControl: async () => ({ clicked: true })
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
    url: "https://www.tohotheater.jp/net/schedule/001/TNPI2000J01.do"
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
            context: "IMAXレーザー 字幕 スクリーン７ 残席わずか"
          },
          {
            label: "13:00 販売開始 12:00",
            titleCandidates: ["映画B"],
            context: "SCREEN X 販売期間外"
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
  assert.deepEqual(result.showtimes[1]?.formats, ["SCREENX"]);
  assert.equal(result.showtimes[1]?.screen, undefined);
  assert.equal(result.showtimes[1]?.availability, "unavailable");
});

test("TOHO waits for a switched future date sale placeholder to hydrate before reporting availability", async () => {
  const rows = theaterRows();
  const scheduleUrl = rows[0]!.url;
  const initial = {
    theaterNames: ["TOHOシネマズ テスト1"],
    scheduleHeadingCount: 1,
    dates: [
      { label: "2026年8月16日", selected: true, clickable: false },
      { label: "2026年8月17日", selected: false, clickable: true }
    ],
    showtimes: [{ label: "10:00 ～ 12:05", titleCandidates: ["映画A"], context: "販売中 スクリーン 1" }],
    emptySchedule: false
  };
  const switchedPlaceholder = {
    theaterNames: ["TOHOシネマズ テスト1"],
    scheduleHeadingCount: 1,
    dates: [
      { label: "2026年8月16日", selected: false, clickable: true },
      { label: "2026年8月17日", selected: true, clickable: false }
    ],
    showtimes: [{ label: "13:00 ～ 15:05", titleCandidates: ["映画A"], context: "販売期間外 スクリーン 2" }],
    emptySchedule: false
  };
  const hydrated = {
    ...switchedPlaceholder,
    showtimes: [{ label: "13:00 ～ 15:05", titleCandidates: ["映画A"], context: "販売中 スクリーン 2" }]
  };
  const runtime = fakeRuntime([
    { url: THEATER_LIST_URL, value: { rows } },
    { url: scheduleUrl, value: initial },
    { url: scheduleUrl, value: { matched: 1, clicked: true } },
    { url: scheduleUrl, value: switchedPlaceholder },
    { url: scheduleUrl, value: hydrated }
  ]);
  const adapter = new TohoReadAdapter(runtime);

  const result = await adapter.getShowtimes({ theater: "テスト1", date: "2026-08-17" });

  assert.equal(result.date, "2026-08-17");
  assert.equal(result.showtimes.length, 1);
  assert.equal(result.showtimes[0]?.startTime, "13:00");
  assert.equal(result.showtimes[0]?.availability, "unknown");
  assert.equal(result.showtimes[0]?.screen, "2");
});

test("TOHO preserves a genuinely stable unavailable state after the bounded hydration wait", async () => {
  const rows = theaterRows();
  const scheduleUrl = rows[0]!.url;
  const initial = {
    theaterNames: ["TOHOシネマズ テスト1"],
    scheduleHeadingCount: 1,
    dates: [
      { label: "2026年8月16日", selected: true, clickable: false },
      { label: "2026年8月17日", selected: false, clickable: true }
    ],
    showtimes: [{ label: "10:00 ～ 12:05", titleCandidates: ["映画A"], context: "販売中 スクリーン 1" }],
    emptySchedule: false
  };
  const stableUnavailable = {
    theaterNames: ["TOHOシネマズ テスト1"],
    scheduleHeadingCount: 1,
    dates: [
      { label: "2026年8月16日", selected: false, clickable: true },
      { label: "2026年8月17日", selected: true, clickable: false }
    ],
    showtimes: [{ label: "13:00 ～ 15:05", titleCandidates: ["映画A"], context: "販売期間外 スクリーン 2" }],
    emptySchedule: false
  };
  const runtime = fakeRuntime([
    { url: THEATER_LIST_URL, value: { rows } },
    { url: scheduleUrl, value: initial },
    { url: scheduleUrl, value: { matched: 1, clicked: true } },
    { url: scheduleUrl, value: stableUnavailable },
    ...Array.from({ length: 16 }, () => ({ url: scheduleUrl, value: stableUnavailable }))
  ]);
  const adapter = new TohoReadAdapter(runtime);

  const result = await adapter.getShowtimes({ theater: "テスト1", date: "2026-08-17" });

  assert.equal(result.showtimes.length, 1);
  assert.equal(result.showtimes[0]?.availability, "unavailable");
});

test("TOHO accepts the observed official schedule subdomain redirect only when the reviewed theater path is unchanged", async () => {
  const rows = theaterRows();
  rows[0] = {
    id: "001",
    name: "TOHOシネマズ テスト1",
    url: "https://www.tohotheater.jp/net/schedule/001/TNPI2000J01.do"
  };
  const observedScheduleUrl = "https://hlo.tohotheater.jp/net/schedule/001/TNPI2000J01.do";
  const runtime = fakeRuntime([
    { url: THEATER_LIST_URL, value: { rows } },
    {
      url: observedScheduleUrl,
      value: {
        theaterNames: ["TOHOシネマズ テスト1"],
        scheduleHeadingCount: 1,
        dates: [{ label: "2026年8月13日", selected: true, clickable: false }],
        showtimes: [{ label: "10:00 ～ 12:05", titleCandidates: ["映画A"], context: "スクリーン 1" }],
        emptySchedule: false
      }
    }
  ]);
  const adapter = new TohoReadAdapter(runtime);
  const result = await adapter.getShowtimes({ theater: "テスト1" });

  assert.equal(result.theater.id, "001");
  assert.equal(result.sourceUrl, observedScheduleUrl);
  assert.equal(result.showtimes[0]?.sourceUrl, observedScheduleUrl);
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


test("TOHO seat-map normalization derives read-only availability and preserves physical gaps without executing seat controls", () => {
  const theater = {
    provider: "toho" as const,
    id: "036",
    name: "TOHOシネマズ ららぽーと横浜",
    aliases: ["TOHOシネマズ ららぽーと横浜"],
    url: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do",
    sourceUrl: THEATER_LIST_URL
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
  const rawSeats = Array.from({ length: 20 }, (_, index) => {
    const number = String(index + 1);
    return {
      id: `C-${number}`,
      row: "C",
      number,
      src: index === 18 ? "seat_0.gif" : index === 19 ? "seat_2.gif" : "seat_1.gif",
      onclick: index >= 18 ? "" : `JavaScript:seatSelect('C','${number}', '1');`,
      x: index < 10 ? index : index + 2,
      y: 10
    };
  });
  rawSeats.push(
    { id: "HC-1", row: "HC", number: "1", src: "seat_4.gif", onclick: "JavaScript:seatSelect('HC','1', '1');", x: 10, y: 10 },
    { id: "HC-2", row: "HC", number: "2", src: "seat_4.gif", onclick: "JavaScript:seatSelect('HC','2', '1');", x: 11, y: 10 }
  );
  const seatMap = normalizeTohoSeatSnapshot(
    {
      title: "座席指定 || TOHOシネマズ",
      selectedSummary: "",
      standardCapacity: 20,
      wheelchairCapacity: 2,
      gridX: Array.from({ length: 22 }, (_, index) => index),
      seats: rawSeats
    },
    "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do",
    theater,
    showtime,
    "2026-08-17T00:30:00.000Z"
  );

  assert.equal(seatMap.seats.length, 22);
  assert.equal(seatMap.screenEdge, undefined);
  assert.equal(seatMap.showtimeIdentity, "toho|036|2026-08-17|映画A|21:10|23:05|3");
  assert.equal(seatMap.seats.find((seat) => seat.id === "C-1")?.state, "available");
  assert.deepEqual(seatMap.seats.find((seat) => seat.id === "C-19"), {
    id: "C-19", row: "C", number: "19", state: "unavailable", unavailableReason: "unknown", attributes: [], rowIndex: 0, columnIndex: 20, x: 20, y: 0
  });
  assert.deepEqual(seatMap.seats.find((seat) => seat.id === "HC-1")?.attributes, ["wheelchair"]);
  assert.equal(seatMap.seats.find((seat) => seat.id === "HC-1")?.state, "available");
  assert.notEqual(seatMap.seats.find((seat) => seat.id === "C-10")?.columnIndex, seatMap.seats.find((seat) => seat.id === "C-11")?.columnIndex);
});

test("TOHO seat-map normalization fails closed on selected-seat state and wrong theater route", () => {
  const theater = {
    provider: "toho" as const,
    id: "036",
    name: "TOHOシネマズ ららぽーと横浜",
    aliases: ["TOHOシネマズ ららぽーと横浜"],
    url: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do",
    sourceUrl: THEATER_LIST_URL
  };
  const showtime = {
    provider: "toho" as const,
    theaterId: "036", theater: theater.name, date: "2026-08-17", movie: "映画A", startTime: "21:10",
    formats: [], screen: "3", availability: "unknown" as const, sourceUrl: theater.url
  };
  const seats = Array.from({ length: 20 }, (_, index) => ({
    id: `C-${index + 1}`, row: "C", number: String(index + 1), src: "seat_1.gif",
    onclick: `JavaScript:seatSelect('C','${index + 1}', '1');`, x: index, y: 0
  }));
  const snapshot = { title: "座席指定 || TOHOシネマズ", selectedSummary: "C-1", gridX: seats.map((seat) => seat.x), seats };
  assert.throws(
    () => normalizeTohoSeatSnapshot(snapshot, "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do", theater, showtime),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => normalizeTohoSeatSnapshot({ ...snapshot, selectedSummary: "" }, "https://hlo.tohotheater.jp/net/ticket/999/TNPI2010J01.do", theater, showtime),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("TOHO getSeatAvailability uses only the exact reviewed showtime and non-member continuation before read-only extraction", async () => {
  const rows = theaterRows();
  const scheduleUrl = rows[0]!.url;
  const promotionUrl = "https://hlo.tohotheater.jp/net/ticket/001/TNPI2040J04.do";
  const seatUrl = "https://hlo.tohotheater.jp/net/ticket/001/TNPI2010J01.do";
  let currentUrl = THEATER_LIST_URL;
  const clicks: Array<{ kind: string; label: string }> = [];
  const seatRows = Array.from({ length: 20 }, (_, index) => ({
    id: `C-${index + 1}`,
    row: "C",
    number: String(index + 1),
    src: "seat_1.gif",
    onclick: `JavaScript:seatSelect('C','${index + 1}', '1');`,
    x: index,
    y: 10
  }));
  const runtime = {
    status: async () => ({ connected: true, url: currentUrl, provider: "toho", officialSurface: true }),
    navigateReviewed: async (url: string) => { currentUrl = url; return url; },
    evaluateSemanticState: async (_provider: string, expression: string) => {
      if (currentUrl === THEATER_LIST_URL) return { url: currentUrl, value: { rows } };
      if (currentUrl === scheduleUrl) {
        if (expression.includes("ScheduleUtils") && expression.includes("const start =")) {
          return { url: currentUrl, value: { matched: 1, labels: ["10:00～12:05 販売中 スクリーン１ (20席)"] } };
        }
        return {
          url: currentUrl,
          value: {
            theaterNames: ["TOHOシネマズ テスト1"],
            scheduleHeadingCount: 1,
            dates: [{ label: "2026年8月17日", selected: true, clickable: false }],
            showtimes: [{ label: "10:00 ～ 12:05", titleCandidates: ["映画A"], context: "販売中 スクリーン１ (20席)" }],
            emptySchedule: false
          }
        };
      }
      if (currentUrl === promotionUrl) {
        return { url: currentUrl, value: { title: "TOHO-ONE会員入会促進 || TOHOシネマズ", exactNonMemberControls: 1, sensitiveFields: 0 } };
      }
      if (currentUrl === seatUrl) {
        return {
          url: currentUrl,
          value: {
            title: "座席指定 || TOHOシネマズ",
            selectedSummary: "",
            standardCapacity: 20,
            wheelchairCapacity: 0,
            gridX: Array.from({ length: 20 }, (_, index) => index),
            seats: seatRows
          }
        };
      }
      throw new Error(`unexpected fake URL: ${currentUrl}`);
    },
    clickReviewedControl: async (label: string) => {
      clicks.push({ kind: "showtime", label });
      currentUrl = promotionUrl;
      return { clicked: label, url: currentUrl };
    },
    clickReviewedIntermediateControl: async (label: string) => {
      clicks.push({ kind: "intermediate", label });
      currentUrl = seatUrl;
      return { clicked: label, url: currentUrl };
    },
    clickControl: async () => { throw new Error("generic or seat click must never be used"); }
  } as unknown as CinemaBrowserRuntime;

  const adapter = new TohoReadAdapter(runtime);
  const result = await adapter.getSeatAvailability({
    theater: "テスト1",
    date: "2026-08-17",
    movie: "映画A",
    startTime: "10:00",
    screen: "1"
  });

  assert.deepEqual(clicks, [
    { kind: "showtime", label: "10:00～12:05 販売中 スクリーン１ (20席)" },
    { kind: "intermediate", label: "ログインせずに購入する" }
  ]);
  assert.equal(result.seatMap.seats.length, 20);
  assert.equal(result.seatMap.seats.every((seat) => seat.state === "available"), true);
  assert.equal(result.seatMap.sourceUrl, seatUrl);
});
