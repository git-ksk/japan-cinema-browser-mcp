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
    "https://github.com/git-ksk/mcp-execution-handoff/archive/57a74fe55ec19c862e102febe942ffd7108d63f7.tar.gz"
  );
  const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
  assert.match(server, /Human browser activity invalidates every prepared transaction confirmation/);
  assert.match(server, /CINEMA_HANDOFF_POLICY\.transaction\.resumeStrategy/);
  assert.match(server, /TOHO checkout is waiting at the reviewed terms-consent boundary/);
  assert.match(server, /利用規約に同意して次へ/);
  const runtime = fs.readFileSync(path.join(root, "src/browser/runtime.ts"), "utf8");
  assert.match(server, /new BrowserHandoffAdapter/);
  assert.match(server, /GATE0B_INPUT_POLICY = Object\.freeze\(\{ tap: true, scroll: true, text: false, key: false \}/);
  assert.match(server, /browserHandoffAdapter\.start\(\{[\s\S]*inputPolicy: GATE0B_INPUT_POLICY/);
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
