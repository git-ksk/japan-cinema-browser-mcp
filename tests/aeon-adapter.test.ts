import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import {
  AeonReadAdapter,
  buildAeonScheduleUrl,
  normalizeAeonScheduleSnapshot,
  normalizeAeonSeatSnapshot,
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

test("AEON adopts the unique visible rendered schedule href before falling back to control clicking", async () => {
  const rows = theaterRows();
  rows[0] = {
    label: "港北ニュータウン ULTILA D-BOX",
    href: "https://www.aeoncinema.com/cinema/kohoku/",
    area: "神奈川"
  };
  const states = [
    {
      url: "https://www.aeoncinema.com/theater/",
      value: { headingCount: 1, rows }
    },
    {
      url: "https://www.aeoncinema.com/cinema/kohoku/",
      value: {
        matchCount: 1,
        href: "https://theater.aeoncinema.com/theaters/kohoku/"
      }
    },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260816",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["8/16（日）"],
        ambiguousTimeGroups: 0,
        showtimes: [{
          movie: "字幕 スパイダーマン：ブランド・ニュー・デイ",
          label: "19:25~22:05",
          context: "字幕 スパイダーマン：ブランド・ニュー・デイ 19:25~22:05 スクリーン2"
        }],
        emptySchedule: false
      }
    }
  ];
  let stateIndex = 0;
  const clicks: string[] = [];
  const navigations: string[] = [];
  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => { navigations.push(url); return url; },
    evaluateSemanticState: async () => {
      const state = states[stateIndex++];
      if (!state) throw new Error("fake semantic state exhausted");
      return state;
    },
    clickReviewedControl: async (label: string) => {
      clicks.push(label);
      return { clicked: label, url: "https://www.aeoncinema.com/cinema/kohoku/" };
    }
  } as unknown as CinemaBrowserRuntime;

  const result = await new AeonReadAdapter(runtime).getShowtimes({
    theater: "港北ニュータウン",
    date: "2026-08-16",
    movie: "スパイダーマン"
  });

  assert.deepEqual(clicks, ["港北ニュータウン ULTILA D-BOX"]);
  assert.deepEqual(navigations, ["https://theater.aeoncinema.com/theaters/kohoku/?date=20260816"]);
  assert.equal(result.showtimes.length, 1);
  assert.equal(result.showtimes[0]?.startTime, "19:25");
});


function aeonSeatTheater() {
  return {
    provider: "aeon" as const,
    id: "kohoku",
    name: "イオンシネマ 港北ニュータウン",
    sourceUrl: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817"
  };
}

function aeonSeatShowtime() {
  return {
    provider: "aeon" as const,
    theaterId: "kohoku",
    theater: "イオンシネマ 港北ニュータウン",
    date: "2026-08-17",
    movie: "[NEW]字幕 オークストリートの異変",
    startTime: "10:40",
    endTime: "13:00",
    formats: [],
    language: "subtitled" as const,
    screen: "6",
    availability: "unknown" as const,
    sourceUrl: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817"
  };
}

function aeonSeatRows() {
  const rows: Array<{ classes: string[]; x: number; y: number; width: number; height: number }> = [];
  for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
    const row = String.fromCharCode(65 + rowIndex);
    for (let column = 1; column <= 6; column += 1) {
      const x = 100 + (column - 1) * 24 + (column >= 4 ? 48 : 0);
      const classes = ["seat", `seat-${row}-${column}`, "normal", column === 1 ? "disabled" : "default"];
      rows.push({ classes, x, y: 100 + rowIndex * 26, width: 18, height: 18 });
    }
  }
  rows[1]!.classes = ["seat", "seat-A-2", "special", "seat-premier", "default"];
  rows[2]!.classes = ["seat", "seat-A-3", "hc", "space", "disabled"];
  return rows;
}

function aeonSeatSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    title: "e席リザーブ | イオンシネマ",
    promptCount: 1,
    nextControlCount: 1,
    bodyText: "イオンシネマ 港北ニュータウン [NEW]字幕 オークストリートの異変 2026年8月17日 10:40 スクリーン6 座席を選んでください",
    seats: aeonSeatRows(),
    screenMarkers: [{ text: "SCREEN", x: 100, y: 40, width: 186, height: 12 }],
    ...overrides
  };
}

test("AEON seat normalization filters to provider seat identities, maps states/attributes, preserves rendered gaps and explicit screen geometry", () => {
  const result = normalizeAeonSeatSnapshot(
    aeonSeatSnapshot(),
    "https://reserve.smart-theater.com/#/purchase/cinema/seat",
    aeonSeatTheater(),
    aeonSeatShowtime(),
    "2026-08-17T00:40:00.000Z"
  );

  assert.equal(result.provider, "aeon");
  assert.equal(result.seats.length, 24);
  assert.equal(result.screenEdge, "top");
  assert.equal(result.sourceUrl, "https://reserve.smart-theater.com/#/purchase/cinema/seat");
  assert.equal(result.seats.find((seat) => seat.id === "A-1")?.state, "unavailable");
  assert.equal(result.seats.find((seat) => seat.id === "A-1")?.unavailableReason, "unknown");
  assert.equal(result.seats.find((seat) => seat.id === "A-2")?.state, "available");
  assert.deepEqual(result.seats.find((seat) => seat.id === "A-2")?.attributes.sort(), ["premium", "provider:aeon:special"].sort());
  assert.deepEqual(result.seats.find((seat) => seat.id === "A-3")?.attributes.sort(), ["provider:aeon:space", "wheelchair"].sort());
  assert.equal(result.seats.find((seat) => seat.id === "A-3")?.state, "unavailable");
  assert.equal(result.seats.find((seat) => seat.id === "A-3")?.rightBoundary, "gap");
  assert.equal(result.seats.find((seat) => seat.id === "A-4")?.leftBoundary, "gap");
  assert.ok((result.seats.find((seat) => seat.id === "A-4")?.columnIndex ?? 0) > (result.seats.find((seat) => seat.id === "A-3")?.columnIndex ?? 0) + 1);
  assert.equal(result.showtimeIdentity, "aeon|kohoku|2026-08-17|[NEW]字幕 オークストリートの異変|10:40|13:00|6");
});

test("AEON seat normalization never infers screen direction without one explicit external screen marker", () => {
  const noMarker = normalizeAeonSeatSnapshot(
    aeonSeatSnapshot({ screenMarkers: [] }),
    "https://reserve.smart-theater.com/#/purchase/cinema/seat",
    aeonSeatTheater(),
    aeonSeatShowtime()
  );
  assert.equal(noMarker.screenEdge, undefined);

  const overlapping = normalizeAeonSeatSnapshot(
    aeonSeatSnapshot({ screenMarkers: [{ text: "SCREEN", x: 130, y: 110, width: 100, height: 10 }] }),
    "https://reserve.smart-theater.com/#/purchase/cinema/seat",
    aeonSeatTheater(),
    aeonSeatShowtime()
  );
  assert.equal(overlapping.screenEdge, undefined);
});

test("AEON seat normalization treats unreviewed/contradictory class combinations as unknown instead of guessing", () => {
  const rows = aeonSeatRows();
  rows[0]!.classes = ["seat", "seat-A-1", "normal", "default", "future-provider-state"];
  rows[1]!.classes = ["seat", "seat-A-2", "normal", "default", "disabled"];
  rows[2]!.classes = ["seat", "seat-A-3", "seat-premier", "default"];
  const result = normalizeAeonSeatSnapshot(
    aeonSeatSnapshot({ seats: rows }),
    "https://reserve.smart-theater.com/#/purchase/cinema/seat",
    aeonSeatTheater(),
    aeonSeatShowtime()
  );
  for (const id of ["A-1", "A-2", "A-3"]) assert.equal(result.seats.find((seat) => seat.id === id)?.state, "unknown", id);
  assert.ok(result.seats.find((seat) => seat.id === "A-1")?.attributes.includes("provider:aeon:unreviewed-class"));
});

test("AEON seat normalization fails closed on any actual active seat", () => {
  const rows = aeonSeatRows();
  rows[7]!.classes = [...rows[7]!.classes.filter((value) => value !== "default"), "active"];
  assert.throws(
    () => normalizeAeonSeatSnapshot(
      aeonSeatSnapshot({ seats: rows }),
      "https://reserve.smart-theater.com/#/purchase/cinema/seat",
      aeonSeatTheater(),
      aeonSeatShowtime()
    ),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && /active\/selected/.test(error.message)
  );
});

test("AEON seat normalization fails closed when theater/movie/date/time/screen cannot all be proven by rendered Smart Theater text", () => {
  const correct = String(aeonSeatSnapshot().bodyText);
  for (const bodyText of [
    correct.replace("港北ニュータウン", "みなとみらい"),
    correct.replace("オークストリートの異変", "別の作品"),
    correct.replace("2026年8月17日", "2026年8月18日"),
    correct.replace("10:40", "11:40"),
    correct.replace("スクリーン6", "スクリーン5"),
    correct.replace("スクリーン6", "スクリーン60")
  ]) {
    assert.throws(
      () => normalizeAeonSeatSnapshot(
        aeonSeatSnapshot({ bodyText }),
        "https://reserve.smart-theater.com/#/purchase/cinema/seat",
        aeonSeatTheater(),
        aeonSeatShowtime()
      ),
      (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED",
      bodyText
    );
  }
});

test("AEON seat normalization rejects wrong/checkout Smart Theater routes even when seat-looking data is present", () => {
  for (const url of [
    "https://reserve.smart-theater.com/#/purchase/transaction/confirm",
    "https://reserve.smart-theater.com/#/purchase/payment",
    "https://example.com/#/purchase/cinema/seat"
  ]) {
    assert.throws(
      () => normalizeAeonSeatSnapshot(aeonSeatSnapshot(), url, aeonSeatTheater(), aeonSeatShowtime()),
      (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED",
      url
    );
  }
});

test("AEON getSeatAvailability uses only reject -> exact showtime entry -> non-member -> read-only seat snapshot and never touches login fields", async () => {
  const rows = theaterRows();
  rows[0] = {
    label: "港北ニュータウン ULTILA D-BOX",
    href: "https://theater.aeoncinema.com/theaters/kohoku/",
    area: "神奈川"
  };
  const genericStates = [
    { url: "https://www.aeoncinema.com/theater/", value: { headingCount: 1, rows } },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["8/17（月）"],
        ambiguousTimeGroups: 0,
        showtimes: [{
          movie: "[NEW]字幕 オークストリートの異変",
          label: "10:40~13:00",
          context: "[NEW]字幕 オークストリートの異変 10:40~13:00 スクリーン6 予約購入"
        }],
        emptySchedule: false
      }
    }
  ];
  const scheduleStates = [
    { rejectCount: 1, allowCount: 1, settingsCount: 1, rejectPoint: { x: 10, y: 20 } },
    { rejectCount: 0, allowCount: 0, settingsCount: 0 },
    { matchedRows: 1, controlCount: 1, controlLabel: "10:40~13:00スクリーン6予約購入", point: { x: 30, y: 40 }, context: "exact" }
  ];
  const actions: string[] = [];
  let genericIndex = 0;
  let scheduleIndex = 0;
  let watatheatreReads = 0;
  let seatReads = 0;
  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => {
      const state = genericStates[genericIndex++];
      if (!state) throw new Error("fake generic state exhausted");
      return state;
    },
    evaluateAeonSeatScheduleState: async () => {
      const value = scheduleStates[scheduleIndex++];
      if (!value) throw new Error("fake AEON schedule state exhausted");
      return { url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817", value };
    },
    clickAeonCookieReject: async () => { actions.push("全て拒否"); },
    clickAeonSeatEntryAndAdoptWatatheatre: async () => { actions.push("予約購入"); },
    evaluateAeonReviewedTargetState: async (surface: string) => {
      if (surface === "watatheatre") {
        watatheatreReads += 1;
        if (watatheatreReads === 1) return {
          url: "https://login.watatheatre.aeoncinema.com/login2",
          value: { title: "AEON", guestCount: 0, loginFieldCount: 2, passwordFieldCount: 1, challengeCount: 0 }
        };
        return {
          url: "https://login.watatheatre.aeoncinema.com/login2",
          value: { title: "AEON", guestCount: 1, guestPoint: { x: 50, y: 60 }, loginFieldCount: 2, passwordFieldCount: 1, challengeCount: 0 }
        };
      }
      seatReads += 1;
      if (seatReads === 1) return {
        url: "https://reserve.smart-theater.com/#/purchase/cinema/seat",
        value: aeonSeatSnapshot({ seats: [] })
      };
      return { url: "https://reserve.smart-theater.com/#/purchase/cinema/seat", value: aeonSeatSnapshot() };
    },
    clickAeonGuestPurchaseAndWaitForSeat: async () => { actions.push("チケット購入のみ（会員登録しない）"); return "https://reserve.smart-theater.com/#/purchase/cinema/seat"; },
    fillField: async () => { throw new Error("login fields must never be filled"); },
    clickReviewedControl: async () => { throw new Error("seat flow must not use generic reviewed JS click") }
  } as unknown as CinemaBrowserRuntime;

  const result = await new AeonReadAdapter(runtime).getSeatAvailability({
    theater: "港北ニュータウン",
    date: "2026-08-17",
    movie: "オークストリートの異変",
    startTime: "10:40",
    screen: "6"
  });

  assert.deepEqual(actions, ["全て拒否", "予約購入", "チケット購入のみ（会員登録しない）"]);
  assert.equal(watatheatreReads, 2, "bounded hydration waits for exact guest control");
  assert.equal(seatReads, 2, "bounded hydration waits for actual seats");
  assert.equal(result.seatMap.seats.length, 24);
  assert.equal(result.seatMap.seats.some((seat) => seat.state === "selected"), false);
});

test("AEON getSeatAvailability never automates `全て許可` and fails closed if reject is unavailable", async () => {
  const adapter = new AeonReadAdapter({} as CinemaBrowserRuntime);
  const mutable = adapter as unknown as { getShowtimes: () => Promise<unknown> };
  mutable.getShowtimes = async () => ({
    provider: "aeon",
    theater: aeonSeatTheater(),
    date: "2026-08-17",
    dateAvailable: true,
    availableDates: ["2026-08-17"],
    sourceUrl: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
    showtimes: [aeonSeatShowtime()]
  });
  let clicked = false;
  const runtime = {
    evaluateAeonSeatScheduleState: async () => ({
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: { rejectCount: 0, allowCount: 1, settingsCount: 1 }
    }),
    clickAeonCookieReject: async () => { clicked = true; }
  } as unknown as CinemaBrowserRuntime;
  (adapter as unknown as { runtime: CinemaBrowserRuntime }).runtime = runtime;

  await assert.rejects(
    adapter.getSeatAvailability({ theater: "港北ニュータウン", date: "2026-08-17", movie: "オークストリートの異変", startTime: "10:40", screen: "6" }),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.equal(clicked, false);
});


test("AEON seat DOM reader statically requires seat-[ROW]-[NUMBER] identity and contains no seat-selection click path", () => {
  const source = readFileSync(new URL("../src/providers/aeon/adapter.ts", import.meta.url), "utf8");
  assert.match(source, /querySelectorAll\('\.seat'\)/);
  assert.match(source, /ids\.length !== 1\) continue/);
  assert.match(source, /\^seat-\[A-Z\]\+/);
  assert.doesNotMatch(source, /\.click\s*\(/, "AEON provider adapter must not DOM-click any seat or control directly");
  assert.doesNotMatch(source, /select_seats/);
  assert.doesNotMatch(source, /clickAeon[^\n]*\(.*券種選択へ/);
  assert.doesNotMatch(source, /clickAeon[^\n]*\(.*全て許可/);
  assert.match(source, /guest\.scrollIntoView\(\{ behavior: 'instant', block: 'center', inline: 'nearest' \}\)/);
  assert.match(source, /if \(control === guest\) return \{ x, y \}/);
  assert.match(source, /const ticket = actionable\[0\]\.ticket/);
  assert.match(source, /ticket\.scrollIntoView\(\{ block: 'center', inline: 'nearest', behavior: 'instant' \}\)/);
  assert.match(source, /if \(control === ticket\) return \{ x, y \}/);
  assert.doesNotMatch(source, /const status = actionable\[0\]\.statuses\[0\]/);
});

test("AEON current collapsed schedule is expanded through exact reviewed UI before semantic normalization", async () => {
  const rows = theaterRows();
  rows[0] = {
    label: "港北ニュータウン ULTILA D-BOX",
    href: "https://theater.aeoncinema.com/theaters/kohoku/",
    area: "神奈川"
  };
  const semanticStates = [
    { url: "https://www.aeoncinema.com/theater/", value: { headingCount: 1, rows } },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["本日", "8/18（火）"],
        ambiguousTimeGroups: 0,
        scheduleCardCount: 1,
        collapsedScheduleCardCount: 1,
        invalidScheduleCardCount: 0,
        showtimes: [],
        emptySchedule: false
      }
    },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["本日", "8/18（火）"],
        ambiguousTimeGroups: 0,
        scheduleCardCount: 1,
        collapsedScheduleCardCount: 0,
        invalidScheduleCardCount: 0,
        showtimes: [{
          movie: "[NEW]字幕 レディ・オア・ノット2R15+",
          label: "18:00~20:05",
          context: "18:00~20:05 スクリーン8 予約購入"
        }],
        emptySchedule: false
      }
    }
  ];
  let semanticIndex = 0;
  const expansionStates = [
    { rejectCount: 0, allowCount: 0, settingsCount: 0 },
    { totalCards: 1, invalidCards: 0, collapsedMovies: ["[NEW]字幕 レディ・オア・ノット2R15+"] },
    { ok: true, movie: "[NEW]字幕 レディ・オア・ノット2R15+", label: "上映時間を見る", point: { x: 100, y: 120 } },
    { ok: true, movie: "[NEW]字幕 レディ・オア・ノット2R15+", label: "上映時間を見る", point: { x: 100, y: 120 } },
    { cardCount: 1, totalTickets: 1, visibleTickets: 1 },
    { totalCards: 1, invalidCards: 0, collapsedMovies: [] }
  ];
  let expansionIndex = 0;
  const clicks: Array<{ x: number; y: number }> = [];
  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => {
      const next = semanticStates[semanticIndex++];
      if (!next) throw new Error("semantic state exhausted");
      return next;
    },
    evaluateAeonSeatScheduleState: async () => {
      const value = expansionStates[expansionIndex++];
      if (!value) throw new Error("expansion state exhausted");
      return { url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817", value };
    },
    clickAeonScheduleExpansion: async (point: { x: number; y: number }) => { clicks.push(point); },
    clickAeonCookieReject: async () => undefined,
    clickReviewedControl: async () => ({ clicked: true })
  } as unknown as CinemaBrowserRuntime;

  const result = await new AeonReadAdapter(runtime).getShowtimes({ theater: "港北ニュータウン", date: "2026-08-17" });
  assert.equal(result.showtimes.length, 1);
  assert.equal(result.showtimes[0]?.movie, "[NEW]字幕 レディ・オア・ノット2R15+");
  assert.equal(result.showtimes[0]?.screen, "8");
  assert.deepEqual(clicks, [{ x: 100, y: 120 }]);
});

test("AEON schedule expansion never repeats the same card when one reviewed click does not expose its tickets", async () => {
  const rows = theaterRows();
  rows[0] = { label: "港北ニュータウン", href: "https://theater.aeoncinema.com/theaters/kohoku/", area: "神奈川" };
  const semanticStates = [
    { url: "https://www.aeoncinema.com/theater/", value: { headingCount: 1, rows } },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["本日"],
        ambiguousTimeGroups: 0,
        scheduleCardCount: 1,
        collapsedScheduleCardCount: 1,
        invalidScheduleCardCount: 0,
        showtimes: [],
        emptySchedule: false
      }
    }
  ];
  let semanticIndex = 0;
  let expansionRead = 0;
  let clicks = 0;
  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => semanticStates[semanticIndex++]!,
    evaluateAeonSeatScheduleState: async () => {
      expansionRead += 1;
      if (expansionRead === 1) return { url: "", value: { rejectCount: 0, allowCount: 0, settingsCount: 0 } };
      if (expansionRead === 2) return { url: "", value: { totalCards: 1, invalidCards: 0, collapsedMovies: ["作品A"] } };
      if (expansionRead === 3 || expansionRead === 4) return { url: "", value: { ok: true, movie: "作品A", label: "上映時間を見る", point: { x: 50, y: 60 } } };
      return { url: "", value: { cardCount: 1, totalTickets: 2, visibleTickets: 0 } };
    },
    clickAeonScheduleExpansion: async () => { clicks += 1; },
    clickAeonCookieReject: async () => undefined,
    clickReviewedControl: async () => ({ clicked: true })
  } as unknown as CinemaBrowserRuntime;

  await assert.rejects(
    new AeonReadAdapter(runtime).getShowtimes({ theater: "港北ニュータウン", date: "2026-08-17" }),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.equal(clicks, 1);
});

test("AEON schedule normalization preserves screen identity and treats Web受付終了 as unavailable", () => {
  const showtimes = normalizeAeonScheduleSnapshot(
    {
      title: "上映スケジュール｜白山｜イオンシネマ",
      scheduleHeadingCount: 1,
      theaterNames: ["イオンシネマ 白山"],
      ambiguousTimeGroups: 0,
      scheduleCardCount: 2,
      collapsedScheduleCardCount: 0,
      invalidScheduleCardCount: 0,
      showtimes: [
        { movie: "作品A", label: "18:00~20:05", context: "18:00~20:05 スクリーン8 予約購入" },
        { movie: "作品B", label: "20:35~22:40", context: "20:35~22:40 スクリーン3 Web受付終了" }
      ],
      emptySchedule: false
    },
    hakusanTheater(),
    "2026-08-17",
    "https://theater.aeoncinema.com/theaters/hakusan/?date=20260817"
  );

  assert.deepEqual(showtimes.map((row) => [row.movie, row.startTime, row.screen, row.availability]), [
    ["作品A", "18:00", "8", "unknown"],
    ["作品B", "20:35", "3", "unavailable"]
  ]);
});

test("AEON current schedule refuses structural ambiguity before any expansion click", async () => {
  const rows = theaterRows();
  rows[0] = { label: "港北ニュータウン", href: "https://theater.aeoncinema.com/theaters/kohoku/", area: "神奈川" };
  let expansionReads = 0;
  let expansionClicks = 0;
  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async (_provider: string, expression: string) => expression.includes("劇場を探す")
      ? { url: "https://www.aeoncinema.com/theater/", value: { headingCount: 1, rows } }
      : {
          url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
          value: {
            title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
            scheduleHeadingCount: 1,
            theaterNames: ["イオンシネマ 港北ニュータウン"],
            dateLabels: ["本日"],
            ambiguousTimeGroups: 0,
            scheduleCardCount: 1,
            collapsedScheduleCardCount: 0,
            invalidScheduleCardCount: 1,
            showtimes: [],
            emptySchedule: false
          }
        },
    evaluateAeonSeatScheduleState: async () => { expansionReads += 1; return { url: "", value: {} }; },
    clickAeonScheduleExpansion: async () => { expansionClicks += 1; },
    clickAeonCookieReject: async () => undefined,
    clickReviewedControl: async () => ({ clicked: true })
  } as unknown as CinemaBrowserRuntime;

  await assert.rejects(
    new AeonReadAdapter(runtime).getShowtimes({ theater: "港北ニュータウン", date: "2026-08-17" }),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.equal(expansionReads, 0);
  assert.equal(expansionClicks, 0);
});

test("AEON schedule expansion rejects Cookie overlay only through exact 全て拒否 before expanding", async () => {
  const rows = theaterRows();
  rows[0] = { label: "港北ニュータウン", href: "https://theater.aeoncinema.com/theaters/kohoku/", area: "神奈川" };
  const semanticStates = [
    { url: "https://www.aeoncinema.com/theater/", value: { headingCount: 1, rows } },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["本日"],
        ambiguousTimeGroups: 0,
        scheduleCardCount: 1,
        collapsedScheduleCardCount: 1,
        invalidScheduleCardCount: 0,
        showtimes: [],
        emptySchedule: false
      }
    },
    {
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: {
        title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
        scheduleHeadingCount: 1,
        theaterNames: ["イオンシネマ 港北ニュータウン"],
        dateLabels: ["本日"],
        ambiguousTimeGroups: 0,
        scheduleCardCount: 1,
        collapsedScheduleCardCount: 0,
        invalidScheduleCardCount: 0,
        showtimes: [{ movie: "作品A", label: "18:00~20:05", context: "18:00~20:05 スクリーン8 予約購入" }],
        emptySchedule: false
      }
    }
  ];
  let semanticIndex = 0;
  const expansionStates = [
    { rejectCount: 1, allowCount: 1, settingsCount: 1, rejectPoint: { x: 10, y: 10 } },
    { rejectCount: 0, allowCount: 0, settingsCount: 0 },
    { totalCards: 1, invalidCards: 0, collapsedMovies: ["作品A"] },
    { ok: true, movie: "作品A", label: "上映時間を見る", point: { x: 50, y: 60 } },
    { ok: true, movie: "作品A", label: "上映時間を見る", point: { x: 50, y: 60 } },
    { cardCount: 1, totalTickets: 1, visibleTickets: 1 },
    { totalCards: 1, invalidCards: 0, collapsedMovies: [] }
  ];
  let expansionIndex = 0;
  const actions: string[] = [];
  const runtime = {
    status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
    navigateReviewed: async (url: string) => url,
    evaluateSemanticState: async () => semanticStates[semanticIndex++]!,
    evaluateAeonSeatScheduleState: async () => ({
      url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
      value: expansionStates[expansionIndex++]!
    }),
    clickAeonCookieReject: async () => { actions.push("全て拒否"); },
    clickAeonScheduleExpansion: async () => { actions.push("上映時間を見る"); },
    clickReviewedControl: async () => ({ clicked: true })
  } as unknown as CinemaBrowserRuntime;

  const result = await new AeonReadAdapter(runtime).getShowtimes({ theater: "港北ニュータウン", date: "2026-08-17" });
  assert.equal(result.showtimes.length, 1);
  assert.deepEqual(actions, ["全て拒否", "上映時間を見る"]);
});

test("AEON schedule expansion fails closed on trigger ambiguity or hit-test mismatch without clicking", async () => {
  for (const reason of ["trigger_ambiguous", "trigger_hit_test_failed"] as const) {
    const rows = theaterRows();
    rows[0] = { label: "港北ニュータウン", href: "https://theater.aeoncinema.com/theaters/kohoku/", area: "神奈川" };
    const semanticStates = [
      { url: "https://www.aeoncinema.com/theater/", value: { headingCount: 1, rows } },
      {
        url: "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817",
        value: {
          title: "上映スケジュール｜港北ニュータウン｜イオンシネマ",
          scheduleHeadingCount: 1,
          theaterNames: ["イオンシネマ 港北ニュータウン"],
          dateLabels: ["本日"],
          ambiguousTimeGroups: 0,
          scheduleCardCount: 1,
          collapsedScheduleCardCount: 1,
          invalidScheduleCardCount: 0,
          showtimes: [],
          emptySchedule: false
        }
      }
    ];
    let semanticIndex = 0;
    let expansionRead = 0;
    let clicks = 0;
    const runtime = {
      status: async () => ({ connected: true, url: "https://www.aeoncinema.com/theater/", provider: "aeon", officialSurface: true }),
      navigateReviewed: async (url: string) => url,
      evaluateSemanticState: async () => semanticStates[semanticIndex++]!,
      evaluateAeonSeatScheduleState: async () => {
        expansionRead += 1;
        if (expansionRead === 1) return { url: "", value: { rejectCount: 0, allowCount: 0, settingsCount: 0 } };
        if (expansionRead === 2) return { url: "", value: { totalCards: 1, invalidCards: 0, collapsedMovies: ["作品A"] } };
        return { url: "", value: { ok: false, reason, movie: "作品A" } };
      },
      clickAeonScheduleExpansion: async () => { clicks += 1; },
      clickAeonCookieReject: async () => undefined,
      clickReviewedControl: async () => ({ clicked: true })
    } as unknown as CinemaBrowserRuntime;

    await assert.rejects(
      new AeonReadAdapter(runtime).getShowtimes({ theater: "港北ニュータウン", date: "2026-08-17" }),
      (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED",
      reason
    );
    assert.equal(clicks, 0, reason);
  }
});

test("AEON current schedule DOM reader binds visible tickets to their own movie card and excludes hidden ticket truth", () => {
  const source = readFileSync(new URL("../src/providers/aeon/adapter.ts", import.meta.url), "utf8");
  assert.match(source, /if \(scheduleCards\.length > 0\) \{/);
  assert.match(source, /const movie = normalize\(card\.querySelector\('\.p-schedule__header'\)/);
  assert.match(source, /const tickets = Array\.from\(card\.querySelectorAll\('\.p-schedule__ticket'\)\)/);
  assert.match(source, /const visibleTickets = tickets\.filter\(visible\)/);
  assert.match(source, /if \(visibleTickets\.length === 0\) \{/);
  assert.match(source, /for \(const ticket of visibleTickets\) \{/);
  assert.match(source, /Hidden ticket contents are/);
});
