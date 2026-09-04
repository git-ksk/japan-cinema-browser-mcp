import assert from "node:assert/strict";
import test from "node:test";
import type { CinemaCheckoutIntent } from "../src/checkout.js";
import {
  CheckoutContinuationError,
  CheckoutContinuationStore,
  checkoutIntentDigest
} from "../src/checkout-continuation.js";

const intent: CinemaCheckoutIntent = {
  provider: "toho",
  showtime: {
    theater: "TOHOシネマズ ららぽーと横浜",
    theaterId: "036",
    date: "2026-08-18",
    movie: "隣人たち（字幕版）",
    startTime: "21:50",
    screen: "4"
  },
  seatIds: ["A-2"],
  ticketChoices: [{ label: "一般", quantity: 1 }]
};

const fingerprints = {
  algorithm: "sha256" as const,
  context: "sha256:context",
  layout: "sha256:layout",
  state: "sha256:state"
};

function bindingInput() {
  return {
    provider: "toho" as const,
    boundary: "toho_terms_consent_next" as const,
    intent,
    theaterId: "036",
    showtimeIdentity: "toho|036|2026-08-18|隣人たち（字幕版）|21:50|23:35|4",
    selectedSeatIds: ["A-2"],
    preHumanFingerprints: fingerprints,
    sourceSurface: { host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" },
    browserTargetId: "target-1"
  };
}

test("checkout continuation digest is canonical across seat/ticket input ordering", () => {
  const a: CinemaCheckoutIntent = {
    ...intent,
    seatIds: ["A-2", "A-3"],
    ticketChoices: [{ label: "一般", quantity: 1 }, { label: "学生", quantity: 1 }]
  };
  const b: CinemaCheckoutIntent = {
    ...intent,
    seatIds: ["A-3", "A-2"],
    ticketChoices: [{ label: "学生", quantity: 1 }, { label: "一般", quantity: 1 }]
  };
  assert.equal(checkoutIntentDigest(a), checkoutIntentDigest(b));
});

test("checkout continuation digest keeps post-Gate1 eligibility acknowledgement outside the one-shot proof", () => {
  const unacknowledged: CinemaCheckoutIntent = {
    ...intent,
    ticketChoices: [{ providerTicketTypeId: "631-1600-0010-0", label: "大学・専門", quantity: 1 }]
  };
  const acknowledged: CinemaCheckoutIntent = {
    ...intent,
    ticketChoices: [{
      providerTicketTypeId: "631-1600-0010-0",
      label: "大学・専門",
      quantity: 1,
      eligibilityAcknowledgement: { confirmed: true, renderedPriceYen: 1600, eligibilityText: "大学・専門" }
    }]
  };
  const differentTicket: CinemaCheckoutIntent = {
    ...intent,
    ticketChoices: [{ providerTicketTypeId: "643-1100-0010-0", label: "高校生", quantity: 1 }]
  };
  assert.equal(checkoutIntentDigest(unacknowledged), checkoutIntentDigest(acknowledged));
  assert.notEqual(checkoutIntentDigest(unacknowledged), checkoutIntentDigest(differentTicket));
});

test("checkout continuation store keeps only bounded non-secret material and consumes one-shot", () => {
  let now = 1_000;
  const store = new CheckoutContinuationStore(60_000, () => now);
  const created = store.create(bindingInput());
  assert.equal(created.provider, "toho");
  assert.equal(created.boundary, "toho_terms_consent_next");
  assert.equal(created.continuationDigest.startsWith("sha256:"), true);
  assert.deepEqual(Object.keys(created).sort(), [
    "boundary", "browserTargetId", "continuationDigest", "createdAt", "expiresAt", "intentDigest", "preHumanFingerprints",
    "provider", "selectedSeatIds", "showtimeIdentity", "sourceSurface", "theaterId", "version"
  ].sort());
  const match = {
    provider: "toho" as const,
    boundary: "toho_terms_consent_next" as const,
    intent,
    theaterId: "036",
    showtimeIdentity: created.showtimeIdentity,
    selectedSeatIds: ["A-2"],
    browserTargetId: "target-1"
  };
  assert.equal(store.requireMatching(match).continuationDigest, created.continuationDigest);
  assert.equal(store.consumeMatching(match).continuationDigest, created.continuationDigest);
  assert.equal(store.peek(), undefined);
  assert.throws(() => store.requireMatching(match), (error) => error instanceof CheckoutContinuationError && error.code === "BINDING_MISSING");
  now += 1;
});

test("checkout continuation invalidates on target/context/intent mismatch and expiry", () => {
  let now = 10_000;
  const mismatchStore = new CheckoutContinuationStore(1_000, () => now);
  const created = mismatchStore.create(bindingInput());
  assert.throws(
    () => mismatchStore.requireMatching({
      provider: "toho",
      boundary: "toho_terms_consent_next",
      intent,
      theaterId: "036",
      showtimeIdentity: created.showtimeIdentity,
      selectedSeatIds: ["A-2"],
      browserTargetId: "other-target"
    }),
    (error) => error instanceof CheckoutContinuationError && error.code === "BINDING_MISMATCH"
  );
  assert.equal(mismatchStore.peek(), undefined);

  const expiryStore = new CheckoutContinuationStore(1_000, () => now);
  expiryStore.create(bindingInput());
  now += 1_000;
  assert.equal(expiryStore.peek(), undefined);
});

test("checkout continuation refuses unreviewed boundary/provider pairing and non-exact selected seats", () => {
  const store = new CheckoutContinuationStore();
  assert.throws(
    () => store.create({ ...bindingInput(), provider: "aeon" as const }),
    (error) => error instanceof CheckoutContinuationError && error.code === "BINDING_MISMATCH"
  );
  assert.throws(
    () => store.create({ ...bindingInput(), selectedSeatIds: ["A-3"] }),
    (error) => error instanceof CheckoutContinuationError && error.code === "BINDING_MISMATCH"
  );
});
