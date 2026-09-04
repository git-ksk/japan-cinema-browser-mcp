import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CinemaSeat, CinemaSeatMap, SeatAvailabilityResult } from "../src/cinema.js";
import {
  CheckoutCoreError,
  assertCheckoutPreparationEnabled,
  createCheckoutSummaryFromRenderedFacts,
  parseCinemaCheckoutIntent,
  parseRenderedTicketType,
  resolveCheckoutTicketChoices,
  validateCheckoutSeatIntent,
  type CinemaCheckoutIntent,
  type CinemaRenderedTicketType
} from "../src/checkout.js";
import { CINEMA_HANDOFF_POLICY } from "../src/handoff-policy.js";
import { ProviderPolicyError } from "../src/providers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function intent(overrides: Partial<CinemaCheckoutIntent> = {}): CinemaCheckoutIntent {
  return parseCinemaCheckoutIntent({
    provider: "toho",
    showtime: {
      theater: "TOHOシネマズ ららぽーと横浜",
      theaterId: "036",
      date: "2026-08-17",
      movie: "Test Movie",
      startTime: "21:10",
      screen: "3"
    },
    seatIds: ["H-11", "H-12"],
    ticketChoices: [{ providerTicketTypeId: "adult", label: "一般", quantity: 2 }],
    ...overrides
  });
}

function seat(id: string, columnIndex: number, state: CinemaSeat["state"] = "available"): CinemaSeat {
  return {
    id,
    row: "H",
    number: String(11 + columnIndex),
    state,
    attributes: [],
    rowIndex: 7,
    columnIndex,
    x: columnIndex,
    y: 7,
    ...(state === "unavailable" ? { unavailableReason: "sold" as const } : {})
  };
}

function seatMap(overrides: Partial<CinemaSeatMap> = {}): CinemaSeatMap<"toho"> {
  return {
    provider: "toho",
    theaterId: "036",
    theater: "TOHOシネマズ ららぽーと横浜",
    screen: "3",
    showtimeIdentity: "toho|036|2026-08-17|Test Movie|21:10|3",
    seats: [seat("H-11", 0), seat("H-12", 1), seat("H-13", 2)],
    screenEdge: "top",
    observedAt: "2026-08-17T04:00:00.000Z",
    sourceUrl: "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do",
    ...overrides
  };
}

function observation(overrides: Partial<SeatAvailabilityResult<"toho">> = {}): SeatAvailabilityResult<"toho"> {
  return {
    provider: "toho",
    theater: {
      provider: "toho",
      id: "036",
      name: "TOHOシネマズ ららぽーと横浜",
      sourceUrl: "https://www.tohotheater.jp/theater/036.html"
    },
    showtime: {
      provider: "toho",
      theaterId: "036",
      theater: "TOHOシネマズ ららぽーと横浜",
      date: "2026-08-17",
      movie: "Test Movie",
      startTime: "21:10",
      endTime: "23:10",
      formats: ["2D"],
      screen: "3",
      availability: "unknown",
      sourceUrl: "https://hlo.tohotheater.jp/net/schedule/036/TNPI2000J01.do"
    },
    seatMap: seatMap(),
    ...overrides
  };
}

function ticket(overrides: Partial<CinemaRenderedTicketType> = {}): CinemaRenderedTicketType {
  return parseRenderedTicketType({
    providerTicketTypeId: "adult",
    label: "一般",
    priceYen: 2000,
    currency: "JPY",
    ...overrides
  });
}

test("checkout intent is strict and provides no PII, credential, payment, summary, consent, or final-control ingress", () => {
  const base = {
    provider: "toho",
    showtime: {
      theater: "TOHOシネマズ ららぽーと横浜",
      date: "2026-08-17",
      movie: "Test Movie",
      startTime: "21:10"
    },
    seatIds: ["H-11"],
    ticketChoices: [{ label: "一般", quantity: 1 }]
  };
  assert.doesNotThrow(() => parseCinemaCheckoutIntent(base));

  for (const extra of [
    { email: "person@example.com" },
    { phone: "09000000000" },
    { name: "Test User" },
    { birthDate: "1990-01-01" },
    { password: "secret" },
    { otp: "123456" },
    { cardNumber: "4111111111111111" },
    { consent: true },
    { totalYen: 2000 },
    { summary: { totalYen: 2000 } },
    { finalControlLabel: "購入する" }
  ]) {
    assert.throws(
      () => parseCinemaCheckoutIntent({ ...base, ...extra }),
      (error) => error instanceof CheckoutCoreError && error.code === "INVALID_INTENT",
      JSON.stringify(extra)
    );
  }
});

test("checkout intent accepts only exact bounded ticket eligibility acknowledgement", () => {
  const acknowledged = parseCinemaCheckoutIntent({
    provider: "toho",
    showtime: { theater: "T", date: "2026-08-17", movie: "M", startTime: "21:10" },
    seatIds: ["A-1"],
    ticketChoices: [{
      providerTicketTypeId: "student-provider-id",
      label: "大学・専門",
      quantity: 1,
      eligibilityAcknowledgement: { confirmed: true, renderedPriceYen: 1600, eligibilityText: "大学・専門" }
    }]
  });
  assert.deepEqual(acknowledged.ticketChoices[0]?.eligibilityAcknowledgement, {
    confirmed: true,
    renderedPriceYen: 1600,
    eligibilityText: "大学・専門"
  });

  for (const ticketChoice of [
    { label: "大学・専門", quantity: 1, eligibilityAcknowledgement: { confirmed: true, renderedPriceYen: 1600, eligibilityText: "大学・専門" } },
    { providerTicketTypeId: "student-provider-id", label: "大学・専門", quantity: 1, eligibilityAcknowledgement: { confirmed: false, renderedPriceYen: 1600, eligibilityText: "大学・専門" } },
    { providerTicketTypeId: "student-provider-id", label: "大学・専門", quantity: 1, eligibilityAcknowledgement: { confirmed: true, renderedPriceYen: 1600, eligibilityText: "大学・専門", extra: true } }
  ]) {
    assert.throws(
      () => parseCinemaCheckoutIntent({
        provider: "toho",
        showtime: { theater: "T", date: "2026-08-17", movie: "M", startTime: "21:10" },
        seatIds: ["A-1"],
        ticketChoices: [ticketChoice]
      }),
      (error) => error instanceof CheckoutCoreError && error.code === "INVALID_INTENT"
    );
  }
});

test("checkout intent rejects duplicate seats and ticket quantities that do not exactly match the intended seats", () => {
  assert.throws(
    () => parseCinemaCheckoutIntent({
      provider: "toho",
      showtime: { theater: "T", date: "2026-08-17", movie: "M", startTime: "21:10" },
      seatIds: ["A-1", "A-1"],
      ticketChoices: [{ label: "一般", quantity: 2 }]
    }),
    (error) => error instanceof CheckoutCoreError && error.code === "INVALID_INTENT"
  );
  assert.throws(
    () => parseCinemaCheckoutIntent({
      provider: "toho",
      showtime: { theater: "T", date: "2026-08-17", movie: "M", startTime: "21:10" },
      seatIds: ["A-1", "A-2"],
      ticketChoices: [{ label: "一般", quantity: 1 }]
    }),
    (error) => error instanceof CheckoutCoreError && error.code === "INVALID_INTENT"
  );
  assert.throws(
    () => parseCinemaCheckoutIntent({
      provider: "toho",
      showtime: { theater: "T", date: "2026-08-17", movie: "M", startTime: "21:10" },
      seatIds: ["A-1", "A-2"],
      ticketChoices: [{ label: "一般", quantity: 1 }, { label: "一般", quantity: 1 }]
    }),
    (error) => error instanceof CheckoutCoreError && error.code === "INVALID_INTENT"
  );
});

test("all current providers fail closed at the checkoutPreparation capability fence", () => {
  for (const provider of ["toho", "aeon", "109"] as const) {
    assert.throws(
      () => assertCheckoutPreparationEnabled(provider),
      (error) => error instanceof ProviderPolicyError && error.code === "UNSUPPORTED_CAPABILITY",
      provider
    );
  }
});

test("exact seat validation requires two stable observations and never substitutes another available seat", () => {
  const checkoutIntent = intent();
  const first = observation();
  const second = observation({ seatMap: seatMap({ observedAt: "2026-08-17T04:00:02.000Z" }) });
  const plan = validateCheckoutSeatIntent(checkoutIntent, first, second);
  assert.deepEqual(plan.seatIds, ["H-11", "H-12"]);
  assert.equal(plan.freshness.fingerprints.state.startsWith("sha256:"), true);

  const unavailable = observation({
    seatMap: seatMap({
      observedAt: "2026-08-17T04:00:02.000Z",
      seats: [seat("H-11", 0), seat("H-12", 1, "unavailable"), seat("H-13", 2)]
    })
  });
  assert.throws(
    () => validateCheckoutSeatIntent(checkoutIntent, unavailable, unavailable),
    (error) => error instanceof CheckoutCoreError && error.code === "SEAT_UNAVAILABLE" && error.details?.seatId === "H-12"
  );
});

test("seat validation fails closed when showtime, layout, or seat state changes between observations", () => {
  const checkoutIntent = intent();
  const first = observation();
  const changedState = observation({
    seatMap: seatMap({
      observedAt: "2026-08-17T04:00:02.000Z",
      seats: [seat("H-11", 0), seat("H-12", 1), seat("H-13", 2, "unavailable")]
    })
  });
  assert.throws(
    () => validateCheckoutSeatIntent(checkoutIntent, first, changedState),
    (error) => error instanceof CheckoutCoreError && error.code === "STALE_CONTEXT"
  );

  const changedShowtime = observation({ showtime: { ...first.showtime, startTime: "21:20" } });
  assert.throws(
    () => validateCheckoutSeatIntent(checkoutIntent, first, changedShowtime),
    (error) => error instanceof CheckoutCoreError && error.code === "STALE_CONTEXT"
  );
});

test("ticket normalization preserves provider semantics and never infers eligibility from labels", () => {
  const student = parseRenderedTicketType({
    providerTicketTypeId: "student-provider-code",
    label: "学生",
    priceYen: 1500,
    currency: "JPY",
    eligibilityText: "学生証等の確認を求める場合があります"
  });
  assert.equal(student.category, undefined);
  assert.equal(student.eligibilityText, "学生証等の確認を求める場合があります");

  const explicit = parseRenderedTicketType({
    providerTicketTypeId: "student-provider-code",
    label: "学生",
    priceYen: 1500,
    currency: "JPY",
    category: "student",
    eligibilityText: "学生証等の確認を求める場合があります",
    humanReviewRequired: true,
    humanReviewReason: "ticket_eligibility"
  });
  assert.equal(explicit.category, "student");
  assert.equal(explicit.humanReviewReason, "ticket_eligibility");
});

test("ticket resolution uses exact provider id/label, enforces quantities, and surfaces Human review without guessing", () => {
  const checkoutIntent = intent();
  const resolved = resolveCheckoutTicketChoices(checkoutIntent, [ticket()]);
  assert.equal(resolved.selections.length, 1);
  assert.equal(resolved.selections[0]?.ticketType.priceYen, 2000);
  assert.deepEqual(resolved.humanReviewReasons, []);

  const human = resolveCheckoutTicketChoices(
    intent({
      seatIds: ["H-11"],
      ticketChoices: [{ providerTicketTypeId: "student", label: "学生", quantity: 1 }]
    }),
    [ticket({
      providerTicketTypeId: "student",
      label: "学生",
      category: undefined,
      humanReviewRequired: true,
      humanReviewReason: "ticket_eligibility"
    })]
  );
  assert.deepEqual(human.humanReviewReasons, ["ticket_eligibility"]);

  assert.throws(
    () => resolveCheckoutTicketChoices(checkoutIntent, [ticket({ providerTicketTypeId: "other", label: "一般" })]),
    (error) => error instanceof CheckoutCoreError && error.code === "TICKET_UNAVAILABLE"
  );
  assert.throws(
    () => resolveCheckoutTicketChoices(checkoutIntent, [ticket({ maxQuantity: 1 })]),
    (error) => error instanceof CheckoutCoreError && error.code === "TICKET_CONSTRAINT"
  );
});

test("checkout summary is built only from strict rendered facts, matches intent exactly, and binds material values", () => {
  const checkoutIntent = intent();
  const rendered = {
    provider: "toho",
    theater: "TOHOシネマズ ららぽーと横浜",
    theaterId: "036",
    movie: "Test Movie",
    date: "2026-08-17",
    startTime: "21:10",
    screen: "3",
    seats: ["H-12", "H-11"],
    tickets: [{ providerTicketTypeId: "adult", label: "一般", quantity: 2, unitPriceYen: 2000, lineTotalYen: 4000 }],
    subtotalYen: 4000,
    fees: [{ label: "手数料", amountYen: 0 }],
    totalYen: 4000,
    currency: "JPY",
    stage: "review",
    providerStageLabel: "購入内容確認",
    observedAt: "2026-08-17T04:05:00.000Z"
  } as const;
  const summary = createCheckoutSummaryFromRenderedFacts(checkoutIntent, rendered);
  assert.equal(summary.totalYen, 4000);
  assert.match(summary.materialFingerprint, /^sha256:[0-9a-f]{64}$/);

  const laterObservation = createCheckoutSummaryFromRenderedFacts(checkoutIntent, {
    ...rendered,
    observedAt: "2026-08-17T04:05:02.000Z"
  });
  assert.equal(laterObservation.materialFingerprint, summary.materialFingerprint);

  const withoutUnrenderedAmounts = createCheckoutSummaryFromRenderedFacts(checkoutIntent, {
    provider: rendered.provider,
    theater: rendered.theater,
    theaterId: rendered.theaterId,
    movie: rendered.movie,
    date: rendered.date,
    startTime: rendered.startTime,
    screen: rendered.screen,
    seats: rendered.seats,
    tickets: [{ providerTicketTypeId: "adult", label: "一般", quantity: 2 }],
    currency: "JPY",
    stage: "review",
    observedAt: rendered.observedAt
  });
  assert.equal(withoutUnrenderedAmounts.subtotalYen, undefined);
  assert.equal(withoutUnrenderedAmounts.fees, undefined);
  assert.equal(withoutUnrenderedAmounts.totalYen, undefined);

  assert.throws(
    () => createCheckoutSummaryFromRenderedFacts(checkoutIntent, { ...rendered, totalYen: 4500 }),
    (error) => error instanceof CheckoutCoreError && error.code === "AMBIGUOUS_RENDERED_STATE"
  );
  assert.throws(
    () => createCheckoutSummaryFromRenderedFacts(checkoutIntent, { ...rendered, seats: ["H-11", "H-13"] }),
    (error) => error instanceof CheckoutCoreError && error.code === "SUMMARY_MISMATCH"
  );
  for (const extra of [
    { email: "person@example.com" },
    { providerData: { opaque: "value" } },
    { sourceUrl: "https://example.com/opaque-session?token=secret" },
    { rawDialogText: "raw checkout dialog" }
  ]) {
    assert.throws(
      () => createCheckoutSummaryFromRenderedFacts(checkoutIntent, { ...rendered, ...extra }),
      (error) => error instanceof CheckoutCoreError && error.code === "AMBIGUOUS_RENDERED_STATE",
      JSON.stringify(extra)
    );
  }
});

test("Phase 4 core preserves never-replay semantics and does not register prepare_checkout or final purchase behavior", () => {
  assert.deepEqual(CINEMA_HANDOFF_POLICY.semantic_mutation, {
    resumePolicy: "never_replay",
    resumeStrategy: "require_fresh_semantic_action"
  });
  assert.deepEqual(CINEMA_HANDOFF_POLICY.transaction, {
    resumePolicy: "never_replay",
    resumeStrategy: "require_fresh_semantic_action"
  });

  const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
  assert.doesNotMatch(server, /registerTool\(\s*["']prepare_checkout["']/);
  assert.match(server, /error instanceof CheckoutCoreError/);
  assert.match(server, /CheckoutCoreError \|\|[\s\S]*HumanCheckoutHandoffError \|\|[\s\S]*SeatRecommendationError/);
  assert.match(server, /registerTool\(\s*["']start_checkout_handoff["']/);
  const checkout = fs.readFileSync(path.join(root, "src/checkout.ts"), "utf8");
  assert.doesNotMatch(checkout, /finalPurchaseClick|confirm_purchase_action|prepare_purchase_confirmation/);
});
