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


test("reviewed click tolerates transient blank / sibling-provider URLs before the expected provider settles", async () => {
  const runtime = runtimeWithNavigationUrls([
    "https://www.aeoncinema.com/theater/",
    "about:blank",
    "https://109cinemas.net/",
    "https://www.aeoncinema.com/cinema/kohoku/"
  ]);
  const mutable = runtime as unknown as {
    resolveControl: () => Promise<{ label: string; targetUrl?: string }>;
    clickExact: () => Promise<void>;
  };
  mutable.resolveControl = async () => ({ label: "港北ニュータウン" });
  mutable.clickExact = async () => undefined;

  const result = await runtime.clickReviewedControl("港北ニュータウン", "aeon");
  assert.equal(result.url, "https://www.aeoncinema.com/cinema/kohoku/");
});

test("reviewed click still fails closed immediately when it lands on an unreviewed top-level URL", async () => {
  const runtime = runtimeWithNavigationUrls([
    "https://www.aeoncinema.com/theater/",
    "https://example.com/checkout?token=secret"
  ]);
  const mutable = runtime as unknown as {
    resolveControl: () => Promise<{ label: string; targetUrl?: string }>;
    clickExact: () => Promise<void>;
  };
  mutable.resolveControl = async () => ({ label: "港北ニュータウン" });
  mutable.clickExact = async () => undefined;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const started = Date.now();

  try {
    await assert.rejects(
      runtime.clickReviewedControl("港北ニュータウン", "aeon"),
      (error: unknown) =>
        error instanceof BrowserRuntimeError &&
        error.code === "URL_NOT_ALLOWED" &&
        error.details?.phase === "click_reviewed_control"
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(Date.now() - started < 1_500);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]?.[1], {
    phase: "click_reviewed_control",
    expectedProvider: "aeon",
    beforeUrl: "https://www.aeoncinema.com/theater/",
    observedUrl: "https://example.com/checkout",
    elapsedMs: (warnings[0]?.[1] as { elapsedMs: number }).elapsedMs
  });
});
