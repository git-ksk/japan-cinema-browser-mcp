import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "../src/browser/runtime.js";
import type { ChromeProcess } from "../src/browser/chrome-process.js";

function runtimeWithNavigationUrls(urls: string[]): CinemaBrowserRuntime {
  let index = 0;
  const client = {
    Page: {
      loadEventFired: async () => undefined,
      navigate: async () => ({})
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression !== "location.href") return { result: { value: null } };
        const value = urls[Math.min(index, urls.length - 1)] ?? "";
        index += 1;
        return { result: { value } };
      }
    }
  };
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    getClient: () => Promise<unknown>;
    assertNoIntervention: () => Promise<void>;
  };
  mutable.getClient = async () => client;
  mutable.assertNoIntervention = async () => undefined;
  return runtime;
}

test("reviewed navigation tolerates transient blank / sibling-provider URLs before the expected provider commits", async () => {
  const runtime = runtimeWithNavigationUrls([
    "about:blank",
    "https://109cinemas.net/",
    "https://www.aeoncinema.com/theater/"
  ]);

  const result = await runtime.navigateReviewed("https://www.aeoncinema.com/theater/", "aeon");
  assert.equal(result, "https://www.aeoncinema.com/theater/");
});

test("reviewed navigation still fails closed immediately on an unreviewed top-level URL", async () => {
  const runtime = runtimeWithNavigationUrls(["https://example.com/"]);
  const started = Date.now();

  await assert.rejects(
    runtime.navigateReviewed("https://www.aeoncinema.com/theater/", "aeon"),
    (error: unknown) => error instanceof BrowserRuntimeError && error.code === "URL_NOT_ALLOWED"
  );
  assert.ok(Date.now() - started < 1_000);
});
