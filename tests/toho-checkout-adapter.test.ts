import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CinemaSeatMap, SeatAvailabilityResult } from "../src/cinema.js";
import { CheckoutCoreError, type CinemaCheckoutIntent } from "../src/checkout.js";
import { CheckoutContinuationStore } from "../src/checkout-continuation.js";
import { BrowserRuntimeError, type CinemaHandoffAction } from "../src/browser/runtime.js";
import {
  TOHO_SEAT_MAP_EXPRESSION,
  normalizeTohoSeatSnapshot,
  type TohoSeatSnapshot,
  type TohoShowtime,
  type TohoTheater
} from "../src/providers/toho/adapter.js";
import { TohoCheckoutAdapter } from "../src/providers/toho/checkout-adapter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seatUrl = "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do";
const theater: TohoTheater = {
  provider: "toho",
  id: "036",
  name: "TOHOシネマズ ららぽーと横浜",
  aliases: ["TOHOシネマズ ららぽーと横浜"],
  url: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do",
  sourceUrl: "https://www.tohotheater.jp/theater/find.html"
};
const showtime: TohoShowtime = {
  provider: "toho",
  theaterId: theater.id,
  theater: theater.name,
  date: "2026-08-18",
  movie: "隣人たち（字幕版）",
  startTime: "21:50",
  endTime: "23:35",
  formats: [],
  screen: "4",
  availability: "unknown",
  sourceUrl: theater.url
};

function rawSnapshot(selected: readonly string[] = [], unavailable: readonly string[] = []): TohoSeatSnapshot {
  const selectedSet = new Set(selected);
  const unavailableSet = new Set(unavailable);
  const seats = Array.from({ length: 20 }, (_, index) => {
    const number = String(index + 1);
    const id = `A-${number}`;
    if (selectedSet.has(id)) {
      return {
        id,
        row: "A",
        number,
        src: "seat_3.gif",
        alt: `${id} 選択中`,
        onclick: `JavaScript:seatSelect('A','${number}', '1');`,
        x: index,
        y: 10
      };
    }
    if (unavailableSet.has(id)) {
      return { id, row: "A", number, src: "seat_0.gif", alt: `${id} 販売済`, onclick: "", x: index, y: 10 };
    }
    return {
      id,
      row: "A",
      number,
      src: "seat_1.gif",
      alt: `${id} 空席(選択可)`,
      onclick: `JavaScript:seatSelect('A','${number}', '1');`,
      x: index,
      y: 10
    };
  });
  return {
    title: "座席指定 || TOHOシネマズ",
    selectedSummary: "",
    gridX: seats.map((seat) => seat.x),
    seats
  };
}

function map(snapshot = rawSnapshot(), observedAt = "2026-08-17T07:00:00.000Z"): CinemaSeatMap<"toho"> {
  return normalizeTohoSeatSnapshot(snapshot, seatUrl, theater, showtime, observedAt, { allowSelected: true });
}

function result(seatMap: CinemaSeatMap<"toho">): SeatAvailabilityResult<"toho", TohoTheater, TohoShowtime> {
  return { provider: "toho", theater, showtime, seatMap };
}

function intent(seatIds: string[]): CinemaCheckoutIntent {
  return {
    provider: "toho",
    showtime: {
      theater: theater.name,
      theaterId: theater.id,
      date: showtime.date,
      movie: showtime.movie,
      startTime: showtime.startTime,
      screen: showtime.screen
    },
    seatIds,
    ticketChoices: [{ label: "一般", quantity: seatIds.length }]
  };
}

function runtimeForSnapshots(
  snapshots: TohoSeatSnapshot[],
  options: {
    boundaryCount?: number;
    sensitiveFields?: number;
    orientationBlocked?: boolean;
    confirm?: "none" | "exact" | "drift";
    layoutWidth?: number;
    layoutHeight?: number;
    layoutOrientationBlocked?: boolean;
  } = {}
) {
  const clicks: string[] = [];
  const expressions: string[] = [];
  const handoffs: Array<{ reason: "consent"; action: CinemaHandoffAction; message: string }> = [];
  const continuations = new CheckoutContinuationStore();
  const queue = [...snapshots];
  const runtime = {
    evaluateSemanticState: async (_provider: "toho", expression: string) => {
      expressions.push(expression);
      if (expression === TOHO_SEAT_MAP_EXPRESSION) {
        const value = queue.shift();
        if (!value) throw new Error("unexpected seat-map read");
        return { url: seatUrl, value };
      }
      if (expression.includes("width: innerWidth") && expression.includes("height: innerHeight")) {
        return {
          url: seatUrl,
          value: {
            width: options.layoutWidth ?? 1280,
            height: options.layoutHeight ?? 900,
            orientationBlocked: options.layoutOrientationBlocked ?? false
          }
        };
      }
      if (expression.includes("exactConsentNextControls")) {
        const confirm = options.confirm === "none" || options.confirm === undefined
          ? null
          : options.confirm === "exact"
            ? { id: "fooder_menu_conf_bt", tagName: "DIV", className: "seat-action-button", label: "確認する", interactive: true }
            : { id: "other", tagName: "DIV", className: "changed", label: "確認する", interactive: true };
        return {
          url: seatUrl,
          value: {
            orientationBlocked: options.orientationBlocked ?? false,
            confirm,
            exactConsentNextControls: options.boundaryCount ?? 1,
            sensitiveFields: options.sensitiveFields ?? 0,
            visibleLabels: ["利用規約に同意して次へ"]
          }
        };
      }
      const seatId = expression.match(/const id = "([A-Z]+-\d+)"/)?.[1];
      if (!seatId) throw new Error("unexpected semantic expression");
      return {
        url: seatUrl,
        value: {
          ok: true,
          id: seatId,
          tagName: "IMG",
          src: "seat_1.gif",
          alt: `${seatId} 空席(選択可)`,
          x: 100,
          y: 200
        }
      };
    },
    clickReviewedElementPoint: async (_point: { x: number; y: number }, _provider: "toho", element: { id: string }) => {
      clicks.push(element.id);
      return { clickedElementId: element.id, url: seatUrl };
    },
    getReviewedBrowserContext: async () => ({
      provider: "toho" as const,
      targetId: "target-1",
      host: "hlo.tohotheater.jp",
      pathname: "/net/ticket/036/TNPI2010J01.do"
    }),
    createCheckoutContinuation: (input: Parameters<CheckoutContinuationStore["create"]>[0]) => continuations.create(input),
    requireReviewedHumanIntervention: async (input: { reason: "consent"; action: CinemaHandoffAction; message: string }): Promise<never> => {
      handoffs.push(input);
      throw new BrowserRuntimeError("HUMAN_ACTION_REQUIRED", input.message);
    }
  };
  return { runtime, clicks, expressions, handoffs, continuations };
}

function reader(first: CinemaSeatMap<"toho">, second: CinemaSeatMap<"toho">) {
  const queue = [result(first), result(second)];
  return {
    getSeatAvailability: async () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected freshness read");
      return next;
    }
  };
}

test("TOHO internal checkout adapter selects only the exact intended seat set and starts a reviewed never-replay consent handoff", async () => {
  const baselineFirst = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const baselineSecond = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks, expressions, handoffs, continuations } = runtimeForSnapshots(
    [rawSnapshot(), rawSnapshot(["A-2"])],
    { confirm: "none", boundaryCount: 1 }
  );
  const adapter = new TohoCheckoutAdapter(runtime, reader(baselineFirst, baselineSecond));

  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) => error instanceof BrowserRuntimeError && error.code === "HUMAN_ACTION_REQUIRED"
  );

  assert.deepEqual(clicks, ["A-2"]);
  const targetExpression = expressions.find((expression) =>
    expression !== TOHO_SEAT_MAP_EXPRESSION && !expression.includes("exactConsentNextControls")
  );
  assert.ok(targetExpression);
  assert.doesNotThrow(() => new Function(`return ${targetExpression};`));
  assert.equal(handoffs.length, 1);
  assert.deepEqual(handoffs[0]?.action.kind, "reviewed_checkout_boundary");
  assert.equal(handoffs[0]?.action.provider, "toho");
  assert.equal(handoffs[0]?.action.boundary, "toho_terms_consent_next");
  assert.match(handoffs[0]?.action.continuationDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.match(handoffs[0]?.message ?? "", /利用規約に同意して次へ/);
  const binding = continuations.peek();
  assert.deepEqual(binding?.selectedSeatIds, ["A-2"]);
  assert.equal(binding?.browserTargetId, "target-1");
});

test("TOHO checkout rejects the observed mobile-landscape viewport before any seat mutation", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks, handoffs, continuations } = runtimeForSnapshots([], {
    layoutWidth: 756,
    layoutHeight: 469
  });
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));
  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) =>
      error instanceof BrowserRuntimeError &&
      error.code === "UI_STATE_CHANGED" &&
      error.details?.reason === "unsupported_checkout_viewport"
  );
  assert.deepEqual(clicks, []);
  assert.equal(handoffs.length, 0);
  assert.equal(continuations.peek(), undefined);
});

test("TOHO internal checkout adapter revalidates between intended seats and never clicks a substitute or retries", async () => {
  const baselineFirst = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const baselineSecond = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks } = runtimeForSnapshots([
    rawSnapshot(),
    rawSnapshot(["A-2"]),
    rawSnapshot(["A-2"], ["A-10"])
  ]);
  const adapter = new TohoCheckoutAdapter(runtime, reader(baselineFirst, baselineSecond));

  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2", "A-3"])),
    (error) => error instanceof CheckoutCoreError && error.code === "STALE_CONTEXT"
  );
  assert.deepEqual(clicks, ["A-2"]);
});

test("TOHO internal checkout adapter fails before mutation when an exact intended seat becomes stale", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = map(rawSnapshot([], ["A-2"]), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks } = runtimeForSnapshots([]);
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));

  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) => error instanceof CheckoutCoreError && error.code === "STALE_CONTEXT"
  );
  assert.deepEqual(clicks, []);
});

test("TOHO checkout stops after exact seat selection when the rendered seat-confirmation step is present", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks, handoffs, continuations } = runtimeForSnapshots(
    [rawSnapshot(), rawSnapshot(["A-2"])],
    { confirm: "exact", boundaryCount: 0 }
  );
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));

  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) =>
      error instanceof BrowserRuntimeError &&
      error.code === "UNREVIEWED_INTERACTION" &&
      error.details?.controlLabel === "確認する"
  );
  assert.deepEqual(clicks, ["A-2"]);
  assert.equal(handoffs.length, 0);
  assert.equal(continuations.peek(), undefined);
});

test("TOHO checkout fails closed on the rendered landscape-orientation blocker before any continuation binding", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks, handoffs, continuations } = runtimeForSnapshots(
    [rawSnapshot(), rawSnapshot(["A-2"])],
    { orientationBlocked: true, confirm: "exact", boundaryCount: 0 }
  );
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));

  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) =>
      error instanceof BrowserRuntimeError &&
      error.code === "UI_STATE_CHANGED" &&
      error.details?.reason === "unsupported_landscape_layout"
  );
  assert.deepEqual(clicks, ["A-2"]);
  assert.equal(handoffs.length, 0);
  assert.equal(continuations.peek(), undefined);
});

test("TOHO checkout fails closed if the seat-confirmation identity drifts", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks, handoffs } = runtimeForSnapshots(
    [rawSnapshot(), rawSnapshot(["A-2"])],
    { confirm: "drift", boundaryCount: 0 }
  );
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));
  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.deepEqual(clicks, ["A-2"]);
  assert.equal(handoffs.length, 0);
});

test("TOHO first checkout slice refuses special/accessibility seats before any pointer mutation", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = structuredClone(first);
  second.observedAt = "2026-08-17T07:00:02.000Z";
  const target = first.seats.find((seat) => seat.id === "A-2")!;
  target.attributes = ["wheelchair"];
  second.seats.find((seat) => seat.id === "A-2")!.attributes = ["wheelchair"];
  const { runtime, clicks } = runtimeForSnapshots([]);
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));

  await assert.rejects(
    adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])),
    (error) => error instanceof CheckoutCoreError && error.code === "AMBIGUOUS_RENDERED_STATE"
  );
  assert.deepEqual(clicks, []);
});

test("TOHO internal checkout adapter never crosses an absent or sensitive Human consent boundary", async () => {
  const first = map(rawSnapshot(), "2026-08-17T07:00:00.000Z");
  const second = map(rawSnapshot(), "2026-08-17T07:00:02.000Z");
  const { runtime, clicks } = runtimeForSnapshots(
    [rawSnapshot(), rawSnapshot(["A-2"])],
    { confirm: "none", boundaryCount: 0 }
  );
  const adapter = new TohoCheckoutAdapter(runtime, reader(first, second));

  await assert.rejects(adapter.selectExactSeatsToConsentBoundary(intent(["A-2"])));
  assert.deepEqual(clicks, ["A-2"]);
});

test("TOHO Phase 4 adapter remains internal while transaction capabilities are disabled", () => {
  const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
  const providers = fs.readFileSync(path.join(root, "src/providers.ts"), "utf8");
  assert.doesNotMatch(server, /TohoCheckoutAdapter|selectExactSeatsToConsentBoundary|registerTool\(\s*["']prepare_checkout/);
  assert.match(providers, /seatSelection:\s*false/);
  assert.match(providers, /checkoutPreparation:\s*false/);
  assert.match(providers, /purchaseSubmission:\s*false/);
});
