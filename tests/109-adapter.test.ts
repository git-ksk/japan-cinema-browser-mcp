import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import {
  Cinemas109ReadAdapter,
  normalize109ScheduleSnapshot,
  normalize109SeatSnapshot,
  normalize109TheaterPageSnapshot,
  normalize109TheaterSnapshot,
  normalize109TheaterQuery,
  review109ScheduleUrl,
  review109SeatEntryUrl,
  type Cinemas109Theater
} from "../src/providers/109/adapter.js";

interface TheaterRowFixture {
  label: string;
  href: string;
  region?: string;
}

function theaterRows(count = 21): TheaterRowFixture[] {
  const names = [
    "富谷", "109シネマズプレミアム新宿", "佐野", "菖蒲", "木場", "二子玉川", "グランベリーパーク",
    "港北", "川崎", "湘南", "ムービル", "ゆめが丘", "名古屋", "四日市", "明和", "大阪エキスポシティ",
    "箕面", "HAT神戸", "広島", "佐賀", "テスト劇場"
  ];
  return Array.from({ length: count }, (_, index) => ({
    label: names[index] ?? `テスト劇場${index + 1}`,
    href: `https://109cinemas.net/${index === 1 ? "premiumshinjuku" : index === 10 ? "movil" : `theater-${index + 1}`}/`
  }));
}

function kohokuTheater(): Cinemas109Theater {
  return {
    provider: "109",
    id: "kohoku",
    name: "109シネマズ港北",
    url: "https://109cinemas.net/kohoku/",
    sourceUrl: "https://109cinemas.net/"
  };
}

test("109 theater snapshot normalizes visible theater identities and only explicit official single-segment routes", () => {
  const rows = theaterRows();
  rows[7] = { label: "港北", href: "https://109cinemas.net/kohoku/" };
  const result = normalize109TheaterSnapshot(
    { markerCount: 1, boundaryCount: 1, rows },
    "https://109cinemas.net/"
  );
  assert.equal(result.length, 21);
  assert.equal(result.find((theater) => theater.id === "kohoku")?.name, "109シネマズ港北");
  assert.equal(result.find((theater) => theater.id === "premiumshinjuku")?.name, "109シネマズプレミアム新宿");
  assert.equal(result.find((theater) => theater.id === "movil")?.name, "ムービル");
});

test("109 theater snapshot fails closed on a lookalike route or collapsed public theater block", () => {
  const lookalikeRows = theaterRows();
  lookalikeRows[0] = { label: "富谷", href: "https://109cinemas.net.evil.example/tomiya/" };
  assert.throws(
    () => normalize109TheaterSnapshot(
      { markerCount: 1, boundaryCount: 1, rows: lookalikeRows },
      "https://109cinemas.net/"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => normalize109TheaterSnapshot(
      { markerCount: 1, boundaryCount: 1, rows: theaterRows(5) },
      "https://109cinemas.net/"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("109 reviewed schedule route accepts verbatim public queries but rejects wrong domain, port, theater, route and calendar date", () => {
  assert.deepEqual(
    review109ScheduleUrl("https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13", "kohoku"),
    {
      url: "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13",
      theaterId: "kohoku",
      date: "2026-08-13"
    }
  );
  assert.equal(
    review109ScheduleUrl("https://109cinemas.net/premiumshinjuku/schedules/20260813.html?20260811=", "premiumshinjuku").date,
    "2026-08-13"
  );

  for (const value of [
    "https://109cinemas.net.evil.example/kohoku/schedules/20260813.html?theater_code=13",
    "https://user:pass@109cinemas.net/kohoku/schedules/20260813.html?theater_code=13",
    "https://109cinemas.net:8443/kohoku/schedules/20260813.html?theater_code=13"
  ]) {
    assert.throws(
      () => review109ScheduleUrl(value, "kohoku"),
      (error) => error instanceof BrowserRuntimeError && error.code === "URL_NOT_ALLOWED"
    );
  }
  assert.throws(
    () => review109ScheduleUrl("https://109cinemas.net/kawasaki/schedules/20260813.html?theater_code=13", "kohoku"),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => review109ScheduleUrl("https://109cinemas.net/kohoku/movies/20260813.html", "kohoku"),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => review109ScheduleUrl("https://109cinemas.net/kohoku/schedules/20260231.html?theater_code=13", "kohoku"),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("109 theater page adopts only visible explicit schedule links and validates theater/date identity", () => {
  const theater = kohokuTheater();
  const routes = normalize109TheaterPageSnapshot(
    {
      title: "１０９シネマズ港北",
      theaterNames: ["109シネマズ港北", "109シネマズ港北"],
      scheduleMarkerCount: 1,
      dateRows: [
        { label: "08/12(水) 109シネマズデイ", href: "https://109cinemas.net/kohoku/schedules/20260812.html?theater_code=13" },
        { label: "08/13(木)", href: "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13" }
      ],
      emptySchedule: false
    },
    theater,
    theater.url
  );
  assert.deepEqual(routes.map((route) => route.date), ["2026-08-12", "2026-08-13"]);

  assert.throws(
    () => normalize109TheaterPageSnapshot(
      {
        title: "１０９シネマズ港北",
        theaterNames: ["109シネマズ港北"],
        scheduleMarkerCount: 1,
        dateRows: [{ label: "08/14(金)", href: "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13" }]
      },
      theater,
      theater.url
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );

  assert.throws(
    () => normalize109TheaterPageSnapshot(
      {
        title: "１０９シネマズ川崎",
        theaterNames: ["109シネマズ川崎"],
        scheduleMarkerCount: 1,
        dateRows: [{ label: "08/13(木)", href: "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13" }]
      },
      theater,
      theater.url
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("109 schedule snapshot returns compact movie/showtime/screen/format/language/availability facts", () => {
  const theater = kohokuTheater();
  const showtimes = normalize109ScheduleSnapshot(
    {
      title: "2026-08-13 - 上映スケジュール | 109シネマズ港北",
      dateHeadings: ["2026/08/13 （木）"],
      ambiguousTimeGroups: 0,
      unresolvedGroupCount: 0,
      showtimes: [
        {
          movie: "スパイダーマン:ブランド・ニュー・デイ[字幕] SUB]SPIDER MAN BRAND NEW DAY",
          label: "15:40~18:15",
          screen: "シアター4",
          screenContext: "シアター4 IMAXレーザー 2D 145分",
          availability: "残席わずか",
          context: "15:40~18:15 残席わずか"
        },
        {
          movie: "ミニオンズ&モンスターズ[吹替] DUB]MINIONS AND MONSTERS",
          label: "18:35~20:15",
          screen: "シアター2",
          screenContext: "シアター2 ULTRA 4DX 3D 90分",
          availability: "満席",
          context: "18:35~20:15 満席"
        },
        {
          movie: "ブルーロック BLUELOCK",
          label: "21:05~23:25",
          screen: "シアター5",
          screenContext: "シアター5 2D 128分",
          availability: "販売開始前",
          context: "21:05~23:25 販売開始前"
        },
        {
          movie: "映画ちいかわ 人魚の島のひみつ",
          label: "10:45~12:35",
          screen: "シアター1",
          screenContext: "シアター1 SAION -SR EDITION- 2D",
          availability: "空席あり",
          context: "10:45~12:35 空席あり"
        }
      ],
      emptySchedule: false
    },
    theater,
    "2026-08-13",
    "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13"
  );

  assert.equal(showtimes.length, 4);
  assert.equal(showtimes[0]?.screen, "4");
  assert.equal(showtimes[0]?.language, "subtitled");
  assert.deepEqual(showtimes[0]?.formats, ["IMAX LASER", "2D"]);
  assert.equal(showtimes[0]?.availability, "limited");
  assert.equal(showtimes[1]?.language, "dubbed");
  assert.deepEqual(showtimes[1]?.formats, ["ULTRA 4DX", "3D"]);
  assert.equal(showtimes[1]?.availability, "sold_out");
  assert.equal(showtimes[2]?.availability, "unavailable");
  assert.deepEqual(showtimes[3]?.formats, ["SAION SR EDITION", "2D"]);
  assert.equal(showtimes[3]?.availability, "unknown");
});

test("109 schedule snapshot fails closed on wrong theater/date, ambiguous grouping or unresolved movie/screen", () => {
  const theater = kohokuTheater();
  const base = {
    title: "2026-08-13 - 上映スケジュール | 109シネマズ港北",
    dateHeadings: ["2026/08/13 （木）"],
    ambiguousTimeGroups: 0,
    unresolvedGroupCount: 0,
    showtimes: [{
      movie: "ブルーロック BLUELOCK",
      label: "08:15~10:35",
      screen: "シアター7",
      screenContext: "シアター7 2D",
      availability: "販売開始前",
      context: "08:15~10:35 販売開始前"
    }],
    emptySchedule: false
  };

  assert.throws(
    () => normalize109ScheduleSnapshot(
      { ...base, title: "2026-08-13 - 上映スケジュール | 109シネマズ川崎" },
      theater,
      "2026-08-13",
      "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => normalize109ScheduleSnapshot(
      base,
      theater,
      "2026-08-14",
      "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => normalize109ScheduleSnapshot(
      { ...base, ambiguousTimeGroups: 1 },
      theater,
      "2026-08-13",
      "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.throws(
    () => normalize109ScheduleSnapshot(
      { ...base, unresolvedGroupCount: 1 },
      theater,
      "2026-08-13",
      "https://109cinemas.net/kohoku/schedules/20260813.html?theater_code=13"
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});


test("109 theater query normalizes width/spacing and only uses locality labels rendered by the public theater list", async () => {
  assert.equal(normalize109TheaterQuery(" １０９ シネマズ　ゆめが丘 "), "ゆめが丘");

  const rows = theaterRows();
  rows[7] = { label: "港北", href: "https://109cinemas.net/kohoku/", region: "関東" };
  rows[11] = { label: "ゆめが丘", href: "https://109cinemas.net/yumegaoka/", region: "関東" };
  for (let index = 0; index < rows.length; index += 1) rows[index]!.region ??= "東海";

  const runtime = {
    status: async () => ({ connected: true, url: "https://109cinemas.net/", provider: "109", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => ({
      url: "https://109cinemas.net/",
      value: { markerCount: 1, boundaryCount: 1, rows }
    })
  } as unknown as CinemaBrowserRuntime;
  const adapter = new Cinemas109ReadAdapter(runtime);

  const fullWidth = await adapter.listTheaters("１０９ シネマズ　ゆめが丘");
  assert.deepEqual(fullWidth.theaters.map((theater) => theater.name), ["109シネマズゆめが丘"]);

  const region = await adapter.listTheaters("関東");
  assert.deepEqual(region.theaters.map((theater) => theater.name).sort(), ["109シネマズゆめが丘", "109シネマズ港北"].sort());

  const unsupportedInference = await adapter.listTheaters("横浜");
  assert.deepEqual(unsupportedInference.theaters, [], "do not invent city aliases absent from the reviewed public theater list");
});


test("109 reviewed seat entry accepts only the exact rendered public route shape bound to date/time", () => {
  const url = "https://cinema.109cinemas.net/cgi-bin/pc/resv/resv_shw_ppt.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-17&cs=&stt=1115";
  assert.equal(review109SeatEntryUrl(url, "2026-08-17", "11:15"), url);
  for (const bad of [
    "https://109cinemas.net/cgi-bin/pc/resv/resv_shw_ppt.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-17&cs=&stt=1115",
    "https://cinema.109cinemas.net/cgi-bin/pc/resv/other.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-17&cs=&stt=1115",
    "https://cinema.109cinemas.net/cgi-bin/pc/resv/resv_shw_ppt.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-18&cs=&stt=1115",
    "https://cinema.109cinemas.net/cgi-bin/pc/resv/resv_shw_ppt.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-17&cs=&stt=1115&extra=1"
  ]) {
    assert.throws(
      () => review109SeatEntryUrl(bad, "2026-08-17", "11:15"),
      (error) => error instanceof BrowserRuntimeError
    );
  }
});

test("109 seat-map normalization preserves rendered slot gaps and never treats selected seats as read-only", () => {
  const theater = kohokuTheater();
  const showtime = {
    provider: "109" as const,
    theaterId: "kohoku",
    theater: theater.name,
    date: "2026-08-17",
    movie: "映画A",
    startTime: "11:15",
    endTime: "13:05",
    formats: ["2D" as const],
    screen: "5",
    availability: "unknown" as const,
    sourceUrl: "https://109cinemas.net/kohoku/schedules/20260817.html?theater_code=13"
  };
  const seats = Array.from({ length: 24 }, (_, index) => {
    const row = index < 12 ? "A" : "B";
    const seatNo = index % 12 + 1;
    const slot = seatNo >= 10 ? seatNo + 1 : seatNo;
    return {
      value: `${row} -${String(seatNo).padStart(3, "0")}`,
      disabled: index < 2,
      checked: false,
      seatKey: `${row === "A" ? 1 : 2}-${slot}`,
      universal: index === 0 ? "1" : "",
      group: ""
    };
  });
  const sourceUrl = "https://cinema.109cinemas.net/cgi-bin/pc/resv/resv_shw_ppt.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-17&cs=&stt=1115";
  const map = normalize109SeatSnapshot(
    { title: "座席選択 | １０９シネマズ", timerVisible: true, selectedSummary: "選択座席：0／8席", seats },
    sourceUrl,
    theater,
    showtime
  );
  assert.equal(map.seats.length, 24);
  assert.equal(map.seats[0]?.state, "unavailable");
  assert.deepEqual(map.seats[0]?.attributes, ["provider:universal"]);
  assert.equal(map.seats.find((seat) => seat.id === "A-009")?.rightBoundary, "gap");
  assert.equal(map.seats.find((seat) => seat.id === "A-010")?.leftBoundary, "gap");
  assert.equal(map.screenEdge, undefined, "do not infer 109 screen orientation from row naming");

  const selected = seats.map((seat, index) => index === 5 ? { ...seat, checked: true } : seat);
  assert.throws(
    () => normalize109SeatSnapshot(
      { title: "座席選択 | １０９シネマズ", timerVisible: true, selectedSummary: "選択座席：1／8席", seats: selected },
      sourceUrl,
      theater,
      showtime
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("109 getSeatAvailability adopts one exact rendered showtime href and performs no seat activation", async () => {
  const theater = kohokuTheater();
  const showtime = {
    provider: "109" as const,
    theaterId: "kohoku",
    theater: theater.name,
    date: "2026-08-17",
    movie: "映画A",
    startTime: "11:15",
    endTime: "13:05",
    formats: ["2D" as const],
    screen: "5",
    availability: "unknown" as const,
    sourceUrl: "https://109cinemas.net/kohoku/schedules/20260817.html?theater_code=13"
  };
  const entryUrl = "https://cinema.109cinemas.net/cgi-bin/pc/resv/resv_shw_ppt.cgi?ttc=52350&tsc=13&tssc=17&ymd=2026-08-17&cs=&stt=1115";
  const seats = Array.from({ length: 24 }, (_, index) => ({
    value: `${index < 12 ? "A" : "B"} -${String(index % 12 + 1).padStart(3, "0")}`,
    disabled: false,
    checked: false,
    seatKey: `${index < 12 ? 1 : 2}-${index % 12 + 1}`,
    universal: "",
    group: ""
  }));
  let currentUrl = showtime.sourceUrl;
  const navigations: string[] = [];
  const runtime = {
    navigateReviewed: async (url: string) => { navigations.push(url); currentUrl = url; return url; },
    evaluateSemanticState: async (_provider: string, expression: string) => {
      if (expression.includes("input.seat")) {
        return { url: currentUrl, value: { title: "座席選択 | １０９シネマズ", timerVisible: true, selectedSummary: "選択座席：0／8席", seats } };
      }
      return { url: currentUrl, value: { matched: 1, hrefs: [entryUrl] } };
    }
  } as unknown as CinemaBrowserRuntime;
  const adapter = new Cinemas109ReadAdapter(runtime);
  (adapter as unknown as { getShowtimes: (input: unknown) => Promise<unknown> }).getShowtimes = async () => ({
    provider: "109", theater, date: showtime.date, dateAvailable: true, availableDates: [showtime.date], sourceUrl: showtime.sourceUrl, showtimes: [showtime]
  });
  const result = await adapter.getSeatAvailability({ theater: "港北", date: showtime.date, movie: showtime.movie, startTime: showtime.startTime, screen: showtime.screen });
  assert.deepEqual(navigations, [entryUrl]);
  assert.equal(result.seatMap.seats.length, 24);
  assert.equal(result.seatMap.seats.every((seat) => seat.state === "available"), true);
});
