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

test("AEON reviewed seat entry adopts only the target created by that action and ignores pre-existing startup about:blank", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const scheduleUrl = "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817";
  const targetSequences = [
    [
      { id: "schedule", type: "page", url: scheduleUrl },
      { id: "startup-blank", type: "page", url: "about:blank" }
    ],
    [
      { id: "schedule", type: "page", url: scheduleUrl },
      { id: "startup-blank", type: "page", url: "about:blank" }
    ],
    [
      { id: "schedule", type: "page", url: scheduleUrl },
      { id: "startup-blank", type: "page", url: "about:blank" },
      { id: "new-reservation", type: "page", url: "about:blank" }
    ],
    [
      { id: "schedule", type: "page", url: scheduleUrl },
      { id: "startup-blank", type: "page", url: "about:blank" },
      { id: "new-reservation", type: "page", url: "https://login.watatheatre.aeoncinema.com/auth?eventId=observed" }
    ]
  ];
  let sequenceIndex = 0;
  let adopted = "";
  const fakeClient = {};
  const mutable = runtime as unknown as {
    port: number;
    getClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
    assertNoIntervention: () => Promise<void>;
    trustedClickExactPoint: () => Promise<void>;
    listBrowserTargets: () => Promise<unknown[]>;
    adoptBrowserTarget: (id: string) => Promise<void>;
  };
  mutable.port = 9222;
  mutable.getClient = async () => fakeClient;
  mutable.currentUrlUnchecked = async () => adopted ? "https://login.watatheatre.aeoncinema.com/auth?eventId=observed" : scheduleUrl;
  mutable.assertNoIntervention = async () => undefined;
  mutable.trustedClickExactPoint = async () => undefined;
  mutable.listBrowserTargets = async () => targetSequences[Math.min(sequenceIndex++, targetSequences.length - 1)]!;
  mutable.adoptBrowserTarget = async (id: string) => { adopted = id; };

  await runtime.clickAeonSeatEntryAndAdoptWatatheatre({ x: 100, y: 200 }, "10:40~12:40スクリーン6予約購入");
  assert.equal(adopted, "new-reservation");
  assert.notEqual(adopted, "startup-blank");
});

test("AEON reviewed seat entry refuses wrong or ambiguous newly-created targets", async () => {
  const scheduleUrl = "https://theater.aeoncinema.com/theaters/kohoku/?date=20260817";
  for (const created of [
    [{ id: "new", type: "page", url: "https://example.com/checkout" }],
    [
      { id: "new-a", type: "page", url: "https://login.watatheatre.aeoncinema.com/auth?eventId=a" },
      { id: "new-b", type: "page", url: "https://login.watatheatre.aeoncinema.com/auth?eventId=b" }
    ]
  ]) {
    const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
    let calls = 0;
    const mutable = runtime as unknown as {
      port: number;
      getClient: () => Promise<unknown>;
      currentUrlUnchecked: () => Promise<string>;
      assertNoIntervention: () => Promise<void>;
      trustedClickExactPoint: () => Promise<void>;
      listBrowserTargets: () => Promise<unknown[]>;
    };
    mutable.port = 9222;
    mutable.getClient = async () => ({});
    mutable.currentUrlUnchecked = async () => scheduleUrl;
    mutable.assertNoIntervention = async () => undefined;
    mutable.trustedClickExactPoint = async () => undefined;
    mutable.listBrowserTargets = async () => {
      calls += 1;
      const base = [{ id: "schedule", type: "page", url: scheduleUrl }, { id: "startup", type: "page", url: "about:blank" }];
      return calls <= 2 ? base : [...base, ...created];
    };

    await assert.rejects(
      runtime.clickAeonSeatEntryAndAdoptWatatheatre({ x: 100, y: 200 }, "10:40~12:40スクリーン6予約購入"),
      (error) => error instanceof BrowserRuntimeError && ["URL_NOT_ALLOWED", "UI_STATE_CHANGED"].includes(error.code)
    );
  }
});

test("AEON read-only seat entry refuses any pre-existing Watatheatre/Smart Theater target including stale confirm", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const mutable = runtime as unknown as {
    port: number;
    getClient: () => Promise<unknown>;
    listBrowserTargets: () => Promise<unknown[]>;
  };
  mutable.port = 9222;
  mutable.getClient = async () => ({});
  mutable.listBrowserTargets = async () => [
    { id: "stale", type: "page", url: "https://reserve.smart-theater.com/#/purchase/transaction/confirm" }
  ];

  await assert.rejects(
    runtime.assertNoAeonExternalFlowTargets(),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && /refuses to reuse/.test(error.message)
  );
});

test("AEON non-member continuation allows only observed Watatheatre -> transaction -> exact seat route and strips opaque query from output", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const urls = [
    "https://login.watatheatre.aeoncinema.com/purchase/guest?eventId=observed",
    "https://reserve.smart-theater.com/?projectId=p&eventId=e&initId=i#/purchase/transaction",
    "https://reserve.smart-theater.com/?projectId=p&eventId=e&initId=i#/purchase/cinema/seat"
  ];
  let index = 0;
  const mutable = runtime as unknown as {
    getClient: () => Promise<unknown>;
    currentUrlUnchecked: () => Promise<string>;
    assertNoAeonExternalBlocker: () => Promise<void>;
    trustedClickExactPoint: () => Promise<void>;
  };
  mutable.getClient = async () => ({});
  mutable.currentUrlUnchecked = async () => urls[Math.min(index++, urls.length - 1)]!;
  mutable.assertNoAeonExternalBlocker = async () => undefined;
  mutable.trustedClickExactPoint = async () => undefined;

  const result = await runtime.clickAeonGuestPurchaseAndWaitForSeat({ x: 100, y: 200 });
  assert.equal(result, "https://reserve.smart-theater.com/#/purchase/cinema/seat");
});

test("AEON non-member continuation fails closed on transaction/confirm or payment routes", async () => {
  for (const bad of [
    "https://reserve.smart-theater.com/#/purchase/transaction/confirm",
    "https://reserve.smart-theater.com/#/purchase/payment"
  ]) {
    const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
    const urls = ["https://login.watatheatre.aeoncinema.com/purchase/guest?eventId=observed", bad];
    let index = 0;
    const mutable = runtime as unknown as {
      getClient: () => Promise<unknown>;
      currentUrlUnchecked: () => Promise<string>;
      assertNoAeonExternalBlocker: () => Promise<void>;
      trustedClickExactPoint: () => Promise<void>;
    };
    mutable.getClient = async () => ({});
    mutable.currentUrlUnchecked = async () => urls[Math.min(index++, urls.length - 1)]!;
    mutable.assertNoAeonExternalBlocker = async () => undefined;
    mutable.trustedClickExactPoint = async () => undefined;

    await assert.rejects(
      runtime.clickAeonGuestPurchaseAndWaitForSeat({ x: 100, y: 200 }),
      (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED",
      bad
    );
  }
});

test("AEON trusted pointer primitive dispatches real CDP mouse input only after exact rendered hit-test validation", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const events: Array<Record<string, unknown>> = [];
  const client = {
    Runtime: {
      evaluate: async () => ({ result: { value: { ok: true, label: "全て拒否", reason: null } } })
    },
    Input: {
      dispatchMouseEvent: async (event: Record<string, unknown>) => { events.push(event); }
    }
  };
  const mutable = runtime as unknown as {
    trustedClickExactPoint: (client: unknown, point: { x: number; y: number }, label: string) => Promise<void>;
  };
  await mutable.trustedClickExactPoint(client, { x: 120.5, y: 240.25 }, "全て拒否");
  assert.deepEqual(events.map((event) => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(events[1]?.button, "left");
});

test("provider-adapter exact element pointer mutation dispatches only after exact rendered hit-test", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const events: Array<{ type: string; x?: number; y?: number }> = [];
  const client = {
    Runtime: {
      evaluate: async () => ({ result: { value: { ok: true, id: "A-2", tagName: "IMG", reason: null } } })
    },
    Input: {
      dispatchMouseEvent: async (event: { type: string; x?: number; y?: number }) => { events.push(event); }
    }
  };
  const mutable = runtime as unknown as {
    assertOfficialCurrentUrl: () => Promise<string>;
    assertNoIntervention: () => Promise<void>;
    getClient: () => Promise<unknown>;
  };
  mutable.assertOfficialCurrentUrl = async () => "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do";
  mutable.assertNoIntervention = async () => undefined;
  mutable.getClient = async () => client;

  const result = await runtime.clickReviewedElementPoint(
    { x: 285, y: 234.48 },
    "toho",
    { id: "A-2", tagName: "IMG" }
  );
  assert.equal(result.clickedElementId, "A-2");
  assert.deepEqual(events.map((event) => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
});


test("provider-adapter exact element pointer supports bounded text/href fingerprint without an id", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  const events: Array<{ type: string }> = [];
  const client = {
    Runtime: {
      evaluate: async () => ({ result: { value: {
        ok: true,
        id: "",
        tagName: "A",
        text: "一般2,100円",
        href: "javascript:SelectTicket.setTicket('0', '0', '529-2100-0010-0', '一般', '2,100円')",
        dataModal: "",
        reason: null
      } } })
    },
    Input: { dispatchMouseEvent: async (event: { type: string }) => { events.push(event); } }
  };
  const mutable = runtime as unknown as {
    assertOfficialCurrentUrl: () => Promise<string>;
    assertNoIntervention: () => Promise<void>;
    getClient: () => Promise<unknown>;
  };
  mutable.assertOfficialCurrentUrl = async () => "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J02.do";
  mutable.assertNoIntervention = async () => undefined;
  mutable.getClient = async () => client;
  const href = "javascript:SelectTicket.setTicket('0', '0', '529-2100-0010-0', '一般', '2,100円')";
  const result = await runtime.clickReviewedElementPoint({ x: 100, y: 200 }, "toho", { tagName: "A", text: "一般2,100円", href });
  assert.equal(result.clickedElementText, "一般2,100円");
  assert.deepEqual(events.map((event) => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("provider-adapter exact element pointer mutation fails before dispatch on hit-test identity drift", async () => {
  const runtime = new CinemaBrowserRuntime({} as ChromeProcess, 1_000);
  let dispatches = 0;
  const client = {
    Runtime: {
      evaluate: async () => ({ result: { value: { ok: false, id: "A-3", tagName: "IMG", reason: "identity_mismatch" } } })
    },
    Input: {
      dispatchMouseEvent: async () => { dispatches += 1; }
    }
  };
  const mutable = runtime as unknown as {
    assertOfficialCurrentUrl: () => Promise<string>;
    assertNoIntervention: () => Promise<void>;
    getClient: () => Promise<unknown>;
  };
  mutable.assertOfficialCurrentUrl = async () => "https://hlo.tohotheater.jp/net/ticket/036/TNPI2010J01.do";
  mutable.assertNoIntervention = async () => undefined;
  mutable.getClient = async () => client;

  await assert.rejects(
    runtime.clickReviewedElementPoint({ x: 285, y: 234.48 }, "toho", { id: "A-2", tagName: "IMG" }),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED" && error.details?.observedId === "A-3"
  );
  assert.equal(dispatches, 0);
});
