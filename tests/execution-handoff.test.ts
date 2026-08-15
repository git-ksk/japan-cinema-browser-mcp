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

test("v0.1.0 handoff dependency is immutable and transaction replay remains statically fenced", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(
    pkg.dependencies?.["mcp-execution-handoff"],
    "https://github.com/git-ksk/mcp-execution-handoff/archive/c87fe17b4a9a24bda7aa42e1f40e75a491e72698.tar.gz"
  );
  const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
  assert.match(server, /Human browser activity invalidates every prepared transaction confirmation/);
  assert.match(server, /CINEMA_HANDOFF_POLICY\.transaction\.resumeStrategy/);
  const runtime = fs.readFileSync(path.join(root, "src/browser/runtime.ts"), "utf8");
  assert.match(runtime, /CINEMA_HANDOFF_POLICY\.transaction\.resumePolicy/);
  assert.doesNotMatch(runtime, /captcha.{0,40}(solve|bypass)|hcaptcha.{0,40}(solve|bypass)/i);
});
