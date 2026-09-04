import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ExecutionHandoffState,
  claimHandoffOwner,
  createHandoffOwner,
  handoffOwnerMatches,
  type HandoffOwner
} from "mcp-execution-handoff/core";
import {
  createHandoffRequestState,
  handoffStateMatchesInvocation
} from "mcp-execution-handoff/mcp";
import { CINEMA_HANDOFF_POLICY } from "../src/handoff-policy.js";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import type { ChromeProcess } from "../src/browser/chrome-process.js";
import { OperationQueue } from "../src/operation-queue.js";
import { PurchaseGate } from "../src/purchase-gate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRINCIPAL = "local-stdio";

async function establishTohoGate0bProof(
  runtime: CinemaBrowserRuntime,
  input: { targetId: string; seatId: string; intentDigest: string }
): Promise<void> {
  const mutable = runtime as unknown as {
    targetId: string;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
    getVerificationClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
  };
  mutable.targetId = input.targetId;
  mutable.getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: input.targetId,
    host: "hlo.tohotheater.jp",
    pathname: "/net/ticket/066/TNPI2010J01.do"
  });
  mutable.getVerificationClient = async () => ({
    Runtime: {
      evaluate: async () => ({
        result: {
          value: {
            expectedSeatSelected: true,
            selectedSeatCount: 1,
            renderedSeatCount: 1,
            imageSelectedSeatCount: 1,
            imageExpectedSelected: true,
            termsCheckboxCount: 1,
            termsAcknowledged: true
          }
        }
      })
    }
  });
  mutable.currentUrlUnchecked = async () => "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J01.do";
  const intervention = await runtime.beginTohoSeatDecisionGate0b({ seatId: input.seatId, intentDigest: input.intentDigest });
  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  const verified = await runtime.verifyHumanIntervention(intervention.id);
  assert.equal(verified.status, "ready_to_resume");
  const decision = runtime.resumeAfterHumanIntervention(intervention.id);
  assert.equal(decision.resumePolicy, "never_replay");
}

test("Cinema maps pure reads, navigation, mutations and transactions to progressively stricter handoff policies", () => {
  assert.deepEqual(CINEMA_HANDOFF_POLICY.read, {
    resumePolicy: "replay_safe",
    resumeStrategy: "retry_original"
  });
  assert.deepEqual(CINEMA_HANDOFF_POLICY.navigation, {
    resumePolicy: "revalidate",
    resumeStrategy: "require_fresh_semantic_action"
  });
  assert.deepEqual(CINEMA_HANDOFF_POLICY.semantic_mutation, {
    resumePolicy: "never_replay",
    resumeStrategy: "require_fresh_semantic_action"
  });
  assert.deepEqual(CINEMA_HANDOFF_POLICY.transaction, {
    resumePolicy: "never_replay",
    resumeStrategy: "require_fresh_semantic_action"
  });
});

test("Cinema-specific Human completion advances the resource epoch and never upgrades never_replay", () => {
  const state = new ExecutionHandoffState<never, "access_challenge" | "sign_in" | "consent">(
    () => 1_000,
    () => "cinema-intervention-1"
  );
  const started = state.begin({
    reason: "sign_in",
    resumePolicy: CINEMA_HANDOFF_POLICY.transaction.resumePolicy
  });
  assert.equal(started.epoch, 1);
  assert.equal(state.getAuthority(), "none");
  state.claimHuman(started.id);
  assert.equal(state.getAuthority(), "human");
  const completed = state.markHumanComplete(started.id);
  assert.equal(completed.epoch, 2);
  state.markVerified(started.id);
  const decision = state.resumeAgent(started.id);
  assert.equal(decision.resumePolicy, "never_replay");
  assert.equal(decision.epoch, 2);
});

test("Cinema requestState is bound to the exact invocation and local logical principal", () => {
  const args = { provider: "109", theater: "港北", date: "2026-08-15" };
  const state = createHandoffRequestState({
    toolName: "get_showtimes",
    args,
    interventionId: "cinema-intervention-1",
    epoch: 3,
    resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
    principalBinding: PRINCIPAL
  });
  assert.equal(handoffStateMatchesInvocation(state, "get_showtimes", args, PRINCIPAL), true);
  assert.equal(handoffStateMatchesInvocation(state, "get_showtimes", { ...args, theater: "川崎" }, PRINCIPAL), false);
  assert.equal(handoffStateMatchesInvocation(state, "find_showtimes", args, PRINCIPAL), false);
  assert.equal(handoffStateMatchesInvocation(state, "get_showtimes", args, "other-session"), false);
});

test("Cinema handoff owner cannot be rebound by a parallel or mismatched invocation", () => {
  const owners = new Map<string, HandoffOwner>();
  const original = createHandoffOwner(PRINCIPAL, "get_showtimes", { provider: "toho", theater: "新宿" }, "require_fresh_semantic_action");
  const other = createHandoffOwner(PRINCIPAL, "get_showtimes", { provider: "toho", theater: "池袋" }, "require_fresh_semantic_action");
  assert.ok(claimHandoffOwner(owners, "i1", "awaiting_human", original));
  assert.equal(claimHandoffOwner(owners, "i1", "human_active", other), undefined);
  assert.equal(handoffOwnerMatches(owners.get("i1")!, original), true);
});

test("Cinema consumer serializes browser operations around intervention ownership", async () => {
  const queue = new OperationQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = queue.run(async () => {
    events.push("first:start");
    await blocked;
    events.push("first:end");
  });
  const second = queue.run(async () => {
    events.push("second:start");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("Human handoff invalidation remains separate from purchase confirmation", () => {
  const gate = new PurchaseGate(60_000);
  const prepared = gate.prepare({
    provider: "109",
    theater: "109 Cinemas Test",
    movie: "Test Movie",
    date: "2026-08-15",
    time: "19:10",
    seats: ["G12"],
    ticketSummary: "General x1",
    finalControlLabel: "購入する"
  }, "https://109cinemas.net/example");
  gate.clear();
  assert.throws(() => gate.consume(prepared.confirmationId));
});

test("reviewed Handoff dependency is immutable and transaction replay remains statically fenced", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(
    pkg.dependencies?.["mcp-execution-handoff"],
    "https://github.com/git-ksk/mcp-execution-handoff/archive/19692aba691249dbff6e09c39da0e8cde4b803b6.tar.gz"
  );
  const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
  assert.match(server, /Human browser activity invalidates every prepared transaction confirmation/);
  assert.match(server, /CINEMA_HANDOFF_POLICY\.transaction\.resumeStrategy/);
  assert.match(server, /TOHO checkout is waiting at the reviewed terms-consent boundary/);
  assert.match(server, /利用規約に同意して次へ/);
  const runtime = fs.readFileSync(path.join(root, "src/browser/runtime.ts"), "utf8");
  assert.match(server, /new WindowWebSocketHandoffAdapter/);
  assert.match(server, /host: \{ platform: "macos", hostExecutable: config\.takeover\.hostExecutable \}/);
  assert.match(server, /completeAfterVerification\(\{ id: interventionId, epoch \}\)/);
  const semanticVerifyOffset = server.indexOf("verifyHumanIntervention(state.interventionId)");
  const wssVerifiedCompletionOffset = server.indexOf("completeBrowserHandoffAfterVerification(state.interventionId, state.epoch)");
  assert.ok(semanticVerifyOffset >= 0 && wssVerifiedCompletionOffset > semanticVerifyOffset);
  assert.doesNotMatch(server, /BrowserHandoffAdapter|webrtc_direct|webrtc_relay/);
  assert.match(server, /REVIEWED_POINTER_ONLY_INPUT_POLICY = Object\.freeze\(\{ tap: true, scroll: true, text: false, key: false \}/);
  assert.match(server, /REVIEWED_PURCHASER_FORM_INPUT_POLICY = Object\.freeze\(\{ tap: true, scroll: true, text: true, key: true \}/);
  assert.match(server, /REVIEWED_FULL_CHECKOUT_INPUT_POLICY = Object\.freeze\(\{ tap: true, scroll: true, text: true, key: true \}/);
  assert.match(server, /const inputPolicy = fullCheckout[\s\S]*REVIEWED_FULL_CHECKOUT_INPUT_POLICY[\s\S]*REVIEWED_PURCHASER_FORM_INPUT_POLICY[\s\S]*REVIEWED_POINTER_ONLY_INPUT_POLICY/);
  assert.match(server, /reviewed_full_checkout_handoff/);
  assert.match(server, /A final purchase\/payment button can cause a real charge/);
  assert.match(server, /windowHandoffAdapter\.start\(\{[\s\S]*windowId: targetWindowId[\s\S]*inputPolicy/);
  assert.match(server, /reviewed_gate1_boundary/);
  assert.match(server, /toho_terms_advance_gate1/);
  assert.doesNotMatch(server, /new TakeoverBroker|createLink\(/);
  assert.doesNotMatch(runtime, /captureHumanTakeoverFrame|tapHumanTakeover|insertHumanTakeoverText|pressHumanTakeoverKey/);
  assert.match(runtime, /CINEMA_HANDOFF_POLICY\.transaction\.resumePolicy/);
  assert.doesNotMatch(runtime, /captcha.{0,40}(solve|bypass)|hcaptcha.{0,40}(solve|bypass)/i);
});

test("TOHO Gate 0b creates a Human-only never-replay seat-decision intervention without seat mutation", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  (runtime as unknown as { getReviewedBrowserContext: () => Promise<unknown> }).getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: "target-gate0b",
    host: "hlo.tohotheater.jp",
    pathname: "/net/ticket/066/TNPI2010J01.do"
  });
  await assert.rejects(
    runtime.beginTohoSeatDecisionGate0b({ seatId: "bad", intentDigest: `sha256:${"a".repeat(64)}` }),
    /exact seat identity/
  );
  const intervention = await runtime.beginTohoSeatDecisionGate0b({
    seatId: "A-2",
    intentDigest: `sha256:${"a".repeat(64)}`
  });
  assert.equal(intervention.reason, "seat_decision");
  assert.equal(intervention.resumePolicy, "never_replay");
  assert.equal(intervention.action?.kind, "reviewed_gate0b_boundary");
  if (intervention.action?.kind === "reviewed_gate0b_boundary") {
    assert.equal(intervention.action.provider, "toho");
    assert.equal(intervention.action.boundary, "toho_seat_decision_gate0b");
    assert.equal(intervention.action.seatId, "A-2");
  }
  runtime.cancelHumanIntervention(intervention.id);
});

test("TOHO Gate 0b verification requires the exact bound seat and explicit Human terms acknowledgement", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    targetId: string;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
    getVerificationClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
  };
  mutable.targetId = "target-gate0b-verify";
  mutable.getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: "target-gate0b-verify",
    host: "hlo.tohotheater.jp",
    pathname: "/net/ticket/066/TNPI2010J01.do"
  });
  const intervention = await runtime.beginTohoSeatDecisionGate0b({
    seatId: "A-2",
    intentDigest: `sha256:${"b".repeat(64)}`
  });

  let state = {
    expectedSeatSelected: false,
    selectedSeatCount: 1,
    renderedSeatCount: 1,
    imageSelectedSeatCount: 1,
    imageExpectedSelected: false,
    termsCheckboxCount: 1,
    termsAcknowledged: false
  };
  let expression = "";
  mutable.getVerificationClient = async () => ({
    Runtime: {
      evaluate: async (input: { expression: string }) => {
        expression = input.expression;
        return { result: { value: state } };
      }
    }
  });
  mutable.currentUrlUnchecked = async () => "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J01.do";

  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  await assert.rejects(
    runtime.verifyHumanIntervention(intervention.id),
    (error: unknown) => {
      if (!(error instanceof BrowserRuntimeError) || error.code !== "HUMAN_ACTION_REQUIRED") return false;
      assert.deepEqual(error.details, {
        expectedSeatSelected: false,
        selectedSeatCount: 1,
        renderedSeatCount: 1,
        imageSelectedSeatCount: 1,
        imageExpectedSelected: false,
        termsCheckboxCount: 1,
        termsAcknowledged: false
      });
      return true;
    }
  );
  assert.match(expression, /const expectedSeatId = "A-2"/);
  assert.match(expression, /document\.forms\.namedItem\('bookSeatIntForm'\)/);
  assert.match(expression, /elements\.namedItem\('seat_no'\)/);
  assert.match(expression, /#seatList2 span/);
  assert.match(expression, /expectedSeatDisplay = expectedSeatId\.replace\('-', ''\)/);
  assert.match(expression, /img\[id\]\[alt\]/);
  assert.match(expression, /imageExpectedSelected/);
  assert.match(expression, /input#terms_check\[type="checkbox"\]\[name="terms_check"\]/);
  assert.match(expression, /termsCheckbox\.checked === true/);
  assert.doesNotMatch(expression, /\.click\(|dispatchEvent|利用規約に同意して次へ/);
  assert.doesNotMatch(expression, /A-5/);

  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  state = { ...state, expectedSeatSelected: true };
  await assert.rejects(
    runtime.verifyHumanIntervention(intervention.id),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === "HUMAN_ACTION_REQUIRED" &&
      error.details?.termsAcknowledged === false
  );

  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  state = { ...state, termsAcknowledged: true };
  const verified = await runtime.verifyHumanIntervention(intervention.id);
  assert.equal(verified.status, "ready_to_resume");
  const decision = runtime.resumeAfterHumanIntervention(intervention.id);
  assert.equal(decision.resumePolicy, "never_replay");
});

test("TOHO Gate 1 starts only from the exact Gate 0b postcondition and reviewed provider continuation", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    targetId: string;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
    getClient: () => Promise<unknown>;
  };
  mutable.targetId = "target-gate1";
  mutable.getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: "target-gate1",
    host: "hlo.tohotheater.jp",
    pathname: "/net/ticket/066/TNPI2010J01.do"
  });
  await assert.rejects(
    runtime.beginTohoTermsAdvanceGate1({ seatId: "A-2", intentDigest: `sha256:${"c".repeat(64)}` }),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && /Gate 0b proof/.test(error.message)
  );
  await establishTohoGate0bProof(runtime, {
    targetId: "target-gate1",
    seatId: "A-2",
    intentDigest: `sha256:${"c".repeat(64)}`
  });
  let precondition = {
    expectedSeatSelected: true,
    selectedSeatCount: 1,
    renderedSeatCount: 1,
    termsCheckboxCount: 1,
    termsAcknowledged: true,
    matchingControls: 1,
    controlHrefExact: true,
    formNameExact: true,
    formMethodExact: true,
    formTargetExact: true,
    kakuteiControlCount: 1
  };
  let expression = "";
  mutable.getClient = async () => ({
    Runtime: {
      evaluate: async (input: { expression: string }) => {
        expression = input.expression;
        return { result: { value: precondition } };
      }
    }
  });
  const intervention = await runtime.beginTohoTermsAdvanceGate1({
    seatId: "A-2",
    intentDigest: `sha256:${"c".repeat(64)}`
  });
  assert.equal(intervention.reason, "consent");
  assert.equal(intervention.resumePolicy, "never_replay");
  assert.equal(intervention.action?.kind, "reviewed_gate1_boundary");
  if (intervention.action?.kind === "reviewed_gate1_boundary") {
    assert.equal(intervention.action.provider, "toho");
    assert.equal(intervention.action.boundary, "toho_terms_advance_gate1");
    assert.equal(intervention.action.seatId, "A-2");
  }
  assert.match(expression, /bookSeatIntForm/);
  assert.match(expression, /利用規約に同意して次へ/);
  assert.match(expression, /javascript:bookSeat\(\);/);
  assert.match(expression, /TNPI2010J02\.do/);
  assert.doesNotMatch(expression, /\.click\(|dispatchEvent|submit\(\)/);
  runtime.cancelHumanIntervention(intervention.id);

  await establishTohoGate0bProof(runtime, {
    targetId: "target-gate1",
    seatId: "A-2",
    intentDigest: `sha256:${"c".repeat(64)}`
  });
  precondition = { ...precondition, termsAcknowledged: false };
  await assert.rejects(
    runtime.beginTohoTermsAdvanceGate1({ seatId: "A-2", intentDigest: `sha256:${"c".repeat(64)}` }),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("TOHO Gate 1 verification accepts only the immediate reviewed J02 continuation and never replays the seat action", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    targetId: string;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
    getClient: () => Promise<unknown>;
    getVerificationClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
  };
  mutable.targetId = "target-gate1-verify";
  mutable.getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: "target-gate1-verify",
    host: "hlo.tohotheater.jp",
    pathname: "/net/ticket/066/TNPI2010J01.do"
  });
  mutable.getClient = async () => ({
    Runtime: { evaluate: async () => ({ result: { value: {
      expectedSeatSelected: true,
      selectedSeatCount: 1,
      renderedSeatCount: 1,
      termsCheckboxCount: 1,
      termsAcknowledged: true,
      matchingControls: 1,
      controlHrefExact: true,
      formNameExact: true,
      formMethodExact: true,
      formTargetExact: true,
      kakuteiControlCount: 1
    } } }) }
  });
  mutable.getVerificationClient = async () => ({ Runtime: { evaluate: async () => ({ result: { value: {} } }) } });
  let currentUrl = "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J01.do";
  mutable.currentUrlUnchecked = async () => currentUrl;

  await establishTohoGate0bProof(runtime, {
    targetId: "target-gate1-verify",
    seatId: "A-2",
    intentDigest: `sha256:${"d".repeat(64)}`
  });
  mutable.currentUrlUnchecked = async () => currentUrl;
  const intervention = await runtime.beginTohoTermsAdvanceGate1({
    seatId: "A-2",
    intentDigest: `sha256:${"d".repeat(64)}`
  });
  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  await assert.rejects(
    runtime.verifyHumanIntervention(intervention.id),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "HUMAN_ACTION_REQUIRED"
  );

  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  currentUrl = "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J03.do";
  await assert.rejects(
    runtime.verifyHumanIntervention(intervention.id),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  runtime.cancelHumanIntervention(intervention.id);

  currentUrl = "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J01.do";
  await establishTohoGate0bProof(runtime, {
    targetId: "target-gate1-verify",
    seatId: "A-2",
    intentDigest: `sha256:${"e".repeat(64)}`
  });
  mutable.currentUrlUnchecked = async () => currentUrl;
  const retry = await runtime.beginTohoTermsAdvanceGate1({
    seatId: "A-2",
    intentDigest: `sha256:${"e".repeat(64)}`
  });
  runtime.claimHumanControl(retry.id);
  runtime.markHumanControlComplete(retry.id);
  currentUrl = "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J02.do";
  const verified = await runtime.verifyHumanIntervention(retry.id);
  assert.equal(verified.status, "ready_to_resume");
  const decision = runtime.resumeAfterHumanIntervention(retry.id);
  assert.equal(decision.resumePolicy, "never_replay");
  assert.equal(decision.action?.kind, "reviewed_gate1_boundary");
});


test("TOHO Gate 1 ticket proof is exact, epoch-bound, and one-shot for B2", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const digest = `sha256:${"f".repeat(64)}`;
  await establishTohoGate0bProof(runtime, { targetId: "target-b2-proof", seatId: "A-2", intentDigest: digest });
  const mutable = runtime as unknown as {
    targetId: string;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
    getClient: () => Promise<unknown>;
    getVerificationClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
  };
  mutable.targetId = "target-b2-proof";
  let pathname = "/net/ticket/066/TNPI2010J01.do";
  mutable.getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: "target-b2-proof",
    host: "hlo.tohotheater.jp",
    pathname
  });
  mutable.getClient = async () => ({
    Runtime: { evaluate: async () => ({ result: { value: {
      expectedSeatSelected: true,
      selectedSeatCount: 1,
      renderedSeatCount: 1,
      termsCheckboxCount: 1,
      termsAcknowledged: true,
      matchingControls: 1,
      controlHrefExact: true,
      formNameExact: true,
      formMethodExact: true,
      formTargetExact: true,
      kakuteiControlCount: 1
    } } }) }
  });
  mutable.getVerificationClient = async () => ({ Runtime: { evaluate: async () => ({ result: { value: {} } }) } });
  let currentUrl = "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J01.do";
  mutable.currentUrlUnchecked = async () => currentUrl;
  const gate1 = await runtime.beginTohoTermsAdvanceGate1({ seatId: "A-2", intentDigest: digest });
  runtime.claimHumanControl(gate1.id);
  runtime.markHumanControlComplete(gate1.id);
  pathname = "/net/ticket/066/TNPI2010J02.do";
  currentUrl = "https://hlo.tohotheater.jp/net/ticket/066/TNPI2010J02.do";
  const verified = await runtime.verifyHumanIntervention(gate1.id);
  assert.equal(verified.status, "ready_to_resume");
  runtime.resumeAfterHumanIntervention(gate1.id);

  const proof = await runtime.consumeTohoGate1TicketProof({ seatId: "A-2", intentDigest: digest });
  assert.equal(proof.pathname, "/net/ticket/066/TNPI2010J02.do");
  await assert.rejects(
    runtime.consumeTohoGate1TicketProof({ seatId: "A-2", intentDigest: digest }),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && /one-shot Gate 1 proof/.test(error.message)
  );
});

test("reviewed TOHO checkout boundary carries only a bounded digest action and remains never_replay", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as { targetId: string };
  mutable.targetId = "target-1";
  const checkoutIntent = {
    provider: "toho" as const,
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
  const binding = runtime.createCheckoutContinuation({
    provider: "toho",
    boundary: "toho_terms_consent_next",
    intent: checkoutIntent,
    theaterId: "036",
    showtimeIdentity: "toho|036|2026-08-18|隣人たち（字幕版）|21:50|23:35|4",
    selectedSeatIds: ["A-2"],
    preHumanFingerprints: {
      algorithm: "sha256",
      context: "sha256:context",
      layout: "sha256:layout",
      state: "sha256:state"
    },
    sourceSurface: { host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" },
    browserTargetId: "target-1"
  });

  const mutableHandoff = runtime as unknown as { getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }> };
  mutableHandoff.getReviewedBrowserContext = async () => ({ provider: "toho", targetId: "target-1", host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" });
  await assert.rejects(
    runtime.requireReviewedHumanIntervention({
      reason: "consent",
      action: {
        kind: "reviewed_checkout_boundary",
        provider: "toho",
        boundary: "toho_terms_consent_next",
        continuationDigest: binding.continuationDigest
      },
      message: "review terms in Chrome"
    }),
    (error: unknown) => {
      if (!(error instanceof BrowserRuntimeError)) return false;
      assert.equal(error.code, "HUMAN_ACTION_REQUIRED");
      assert.equal(error.intervention?.resumePolicy, "never_replay");
      assert.deepEqual(error.intervention?.action, {
        kind: "reviewed_checkout_boundary",
        provider: "toho",
        boundary: "toho_terms_consent_next",
        continuationDigest: binding.continuationDigest
      });
      assert.deepEqual(Object.keys(error.intervention?.action ?? {}).sort(), [
        "boundary", "continuationDigest", "kind", "provider"
      ].sort());
      return true;
    }
  );

  const active = runtime.getActiveIntervention();
  assert.ok(active);
  runtime.cancelHumanIntervention(active.id);
  assert.equal(runtime.peekCheckoutContinuation(), undefined);
});

test("reviewed checkout continuation is cleared on browser close and cannot start from an unreviewed boundary", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as { targetId: string };
  mutable.targetId = "target-1";
  const checkoutIntent = {
    provider: "toho" as const,
    showtime: { theater: "TOHOシネマズ ららぽーと横浜", theaterId: "036", date: "2026-08-18", movie: "映画", startTime: "21:50", screen: "4" },
    seatIds: ["A-2"],
    ticketChoices: [{ label: "一般", quantity: 1 }]
  };
  const binding = runtime.createCheckoutContinuation({
    provider: "toho",
    boundary: "toho_terms_consent_next",
    intent: checkoutIntent,
    theaterId: "036",
    showtimeIdentity: "showtime-1",
    selectedSeatIds: ["A-2"],
    preHumanFingerprints: { algorithm: "sha256", context: "sha256:c", layout: "sha256:l", state: "sha256:s" },
    sourceSurface: { host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" },
    browserTargetId: "target-1"
  });
  const mutableHandoff = runtime as unknown as { getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }> };
  mutableHandoff.getReviewedBrowserContext = async () => ({ provider: "toho", targetId: "target-1", host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" });
  await assert.rejects(
    runtime.requireReviewedHumanIntervention({
      reason: "consent",
      action: {
        kind: "reviewed_checkout_boundary",
        provider: "toho",
        boundary: "toho_terms_consent_next",
        continuationDigest: `sha256:${"0".repeat(64)}`
      },
      message: "bad digest"
    }),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
  assert.equal(runtime.peekCheckoutContinuation(), undefined);

  mutable.targetId = "target-1";
  runtime.createCheckoutContinuation({
    provider: "toho",
    boundary: "toho_terms_consent_next",
    intent: checkoutIntent,
    theaterId: "036",
    showtimeIdentity: "showtime-1",
    selectedSeatIds: ["A-2"],
    preHumanFingerprints: { algorithm: "sha256", context: "sha256:c", layout: "sha256:l", state: "sha256:s" },
    sourceSurface: { host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" },
    browserTargetId: "target-1"
  });
  await runtime.close();
  assert.equal(runtime.peekCheckoutContinuation(), undefined);
  void binding;
});

test("reviewed TOHO consent verification returns to Human while the exact pre-consent control remains visible", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    targetId: string;
    getVerificationClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
    detectInterventionSurface: () => Promise<undefined>;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
  };
  mutable.targetId = "target-1";
  const checkoutIntent = {
    provider: "toho" as const,
    showtime: { theater: "TOHOシネマズ ららぽーと横浜", theaterId: "036", date: "2026-08-18", movie: "映画", startTime: "21:50", screen: "4" },
    seatIds: ["A-2"],
    ticketChoices: [{ label: "一般", quantity: 1 }]
  };
  const binding = runtime.createCheckoutContinuation({
    provider: "toho",
    boundary: "toho_terms_consent_next",
    intent: checkoutIntent,
    theaterId: "036",
    showtimeIdentity: "showtime-1",
    selectedSeatIds: ["A-2"],
    preHumanFingerprints: { algorithm: "sha256", context: "sha256:c", layout: "sha256:l", state: "sha256:s" },
    sourceSurface: { host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" },
    browserTargetId: "target-1"
  });
  let startedId = "";
  mutable.getReviewedBrowserContext = async () => ({ provider: "toho", targetId: "target-1", host: "hlo.tohotheater.jp", pathname: "/net/ticket/036/TNPI2010J01.do" });
  await assert.rejects(
    runtime.requireReviewedHumanIntervention({
      reason: "consent",
      action: {
        kind: "reviewed_checkout_boundary",
        provider: "toho",
        boundary: "toho_terms_consent_next",
        continuationDigest: binding.continuationDigest
      },
      message: "review terms"
    }),
    (error: unknown) => {
      if (!(error instanceof BrowserRuntimeError) || !error.intervention) return false;
      startedId = error.intervention.id;
      return error.code === "HUMAN_ACTION_REQUIRED";
    }
  );

  let preConsentVisible = true;
  const client = {
    Runtime: {
      evaluate: async () => ({
        result: { value: { preConsentBoundaryVisible: preConsentVisible, matchingControls: preConsentVisible ? 1 : 0 } }
      })
    }
  };
  mutable.getVerificationClient = async () => client;
  mutable.currentUrlUnchecked = async () => "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do";
  mutable.detectInterventionSurface = async () => undefined;

  runtime.claimHumanControl(startedId);
  runtime.markHumanControlComplete(startedId);
  await assert.rejects(
    runtime.verifyHumanIntervention(startedId),
    (error) => error instanceof BrowserRuntimeError && error.code === "HUMAN_ACTION_REQUIRED"
  );
  assert.equal(runtime.peekCheckoutContinuation()?.continuationDigest, binding.continuationDigest);

  runtime.claimHumanControl(startedId);
  runtime.markHumanControlComplete(startedId);
  preConsentVisible = false;
  const verified = await runtime.verifyHumanIntervention(startedId);
  assert.equal(verified.status, "ready_to_resume");
  const decision = runtime.resumeAfterHumanIntervention(startedId);
  assert.equal(decision.resumePolicy, "never_replay");
  assert.equal(decision.action?.continuationDigest, binding.continuationDigest);
  assert.equal(runtime.peekCheckoutContinuation()?.continuationDigest, binding.continuationDigest);
  runtime.clearCheckoutContinuation();
});

test("TOHO full checkout Handoff stays Human-owned through known purchase stages and returns only an unverified one-shot post-Handoff outcome", async () => {
  const runtime = new CinemaBrowserRuntime({ close: async () => undefined } as unknown as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    targetId: string;
    getReviewedBrowserContext: () => Promise<{ provider: "toho"; targetId: string; host: string; pathname: string }>;
    getVerificationClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
  };
  mutable.targetId = "target-full-checkout";
  mutable.getReviewedBrowserContext = async () => ({
    provider: "toho",
    targetId: "target-full-checkout",
    host: "hlo.tohotheater.jp",
    pathname: "/net/ticket/036/TNPI2010J01.do"
  });
  const digest = `sha256:${"e".repeat(64)}`;
  const intervention = await runtime.beginTohoFullCheckoutHandoff({ seatIds: ["A-2"], intentDigest: digest });
  assert.equal(intervention.reason, "checkout");
  assert.equal(intervention.resumePolicy, "never_replay");
  assert.equal(intervention.action?.kind, "reviewed_full_checkout_handoff");

  let currentUrl = "https://hlo.tohotheater.jp/net/ticket/036/TNPI2030J02.do";
  mutable.currentUrlUnchecked = async () => currentUrl;
  mutable.getVerificationClient = async () => ({
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => ({
        result: { value: expression === "document.title" ? "TOHO post checkout" : undefined }
      })
    }
  });

  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  await assert.rejects(
    runtime.verifyHumanIntervention(intervention.id),
    (error) => error instanceof BrowserRuntimeError && error.code === "HUMAN_ACTION_REQUIRED"
  );

  runtime.claimHumanControl(intervention.id);
  runtime.markHumanControlComplete(intervention.id);
  currentUrl = "https://hlo.tohotheater.jp/net/ticket/036/TNPI2999J02.do";
  const verified = await runtime.verifyHumanIntervention(intervention.id);
  assert.equal(verified.status, "ready_to_resume");
  const decision = runtime.resumeAfterHumanIntervention(intervention.id);
  assert.equal(decision.resumePolicy, "never_replay");
  assert.equal(decision.action?.kind, "reviewed_full_checkout_handoff");
  const outcome = runtime.consumeTohoFullCheckoutHandoffOutcome(digest);
  assert.deepEqual(outcome, {
    provider: "toho",
    handoffCompleted: true,
    purchaseCompletion: "unverified_paid_acceptance_pending",
    pathname: "/net/ticket/036/TNPI2999J02.do",
    title: "TOHO post checkout",
    paidAcceptanceRequired: true
  });
  assert.throws(() => runtime.consumeTohoFullCheckoutHandoffOutcome(digest), /missing or does not match/);
});
