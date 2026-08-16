import test from "node:test";
import assert from "node:assert/strict";
import { executeLiableUsageTask } from "../src/usage.js";

function failingLease(calls: Array<{ units: number; outcome: string }>) {
  return {
    settle: async (units: number, outcome: string) => {
      calls.push({ units, outcome });
      throw new Error("fixture settlement unavailable");
    }
  };
}

test("post-liability settlement failure never masks a successful cinema result", async () => {
  const calls: Array<{ units: number; outcome: string }> = [];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const result = await executeLiableUsageTask(failingLease(calls), async () => ({ ok: true }));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [{ units: 1, outcome: "completed" }]);
  } finally {
    console.error = originalError;
  }
});

test("post-liability settlement failure preserves the original task error", async () => {
  const calls: Array<{ units: number; outcome: string }> = [];
  const expected = new Error("provider task failed");
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      () => executeLiableUsageTask(failingLease(calls), async () => { throw expected; }),
      (error) => error === expected
    );
    assert.deepEqual(calls, [{ units: 1, outcome: "error" }]);
  } finally {
    console.error = originalError;
  }
});

test("returned MCP tool errors are settled as errors without changing the returned payload", async () => {
  const calls: Array<{ units: number; outcome: string }> = [];
  const lease = {
    settle: async (units: number, outcome: string) => {
      calls.push({ units, outcome });
      return {} as never;
    }
  };
  const payload = { isError: true, content: [{ type: "text", text: "bounded provider failure" }] };
  const result = await executeLiableUsageTask(lease, async () => payload);
  assert.equal(result, payload);
  assert.deepEqual(calls, [{ units: 1, outcome: "error" }]);
});
