import test from "node:test";
import assert from "node:assert/strict";
import { PurchaseGate } from "../src/purchase-gate.js";

const summary = {
  provider: "109" as const,
  theater: "109 Cinemas Test",
  movie: "Test Movie",
  date: "2026-08-15",
  time: "19:10",
  seats: ["G12", "G13"],
  ticketSummary: "General x2",
  amountYen: 4000,
  finalControlLabel: "購入する"
};

test("purchase confirmation is one-shot and URL-bound", () => {
  const gate = new PurchaseGate(60_000);
  const prepared = gate.prepare(summary, "https://109cinemas.net/example");
  const consumed = gate.consume(prepared.confirmationId);
  assert.deepEqual(consumed.summary, summary);
  assert.equal(consumed.expectedUrl, "https://109cinemas.net/example");
  assert.throws(() => gate.consume(prepared.confirmationId));
});

test("expired confirmation cannot be consumed", async () => {
  const gate = new PurchaseGate(1);
  const prepared = gate.prepare(summary, "https://109cinemas.net/example");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => gate.consume(prepared.confirmationId));
});
