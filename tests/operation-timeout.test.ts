import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError } from "../src/browser/runtime.js";
import {
  runTimedBrowserOperation,
  type AbortableBrowserOperationRuntime
} from "../src/browser/operation-timeout.js";

class FakeAbortableRuntime implements AbortableBrowserOperationRuntime {
  closeCalls = 0;
  private signal?: AbortSignal;

  runOperation<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    this.signal = signal;
    return task();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  get aborted(): boolean {
    return this.signal?.aborted === true;
  }
}

test("timed browser operation aborts and drains losing work before returning OPERATION_TIMEOUT", async () => {
  const runtime = new FakeAbortableRuntime();
  let lateSideEffect = false;

  await assert.rejects(
    () => runTimedBrowserOperation(
      runtime,
      { timeoutMs: 10, message: "fixture timeout", details: { scope: "fixture" } },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (runtime.aborted) throw new BrowserRuntimeError("OPERATION_TIMEOUT", "observed abort");
        lateSideEffect = true;
        return "too late";
      }
    ),
    (error) =>
      error instanceof BrowserRuntimeError &&
      error.code === "OPERATION_TIMEOUT" &&
      error.details?.scope === "fixture"
  );

  assert.equal(runtime.aborted, true);
  assert.equal(runtime.closeCalls, 1);
  assert.equal(lateSideEffect, false, "the timed operation must return before the losing task can publish a result");
});

test("timed browser operation does not reset the session for an ordinary provider error", async () => {
  const runtime = new FakeAbortableRuntime();
  const expected = new BrowserRuntimeError("UI_STATE_CHANGED", "fixture provider failure");

  await assert.rejects(
    () => runTimedBrowserOperation(
      runtime,
      { timeoutMs: 100, message: "should not fire" },
      async () => { throw expected; }
    ),
    (error) => error === expected
  );

  assert.equal(runtime.closeCalls, 0);
});
