import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError } from "../src/browser/runtime.js";
import type { CinemaReadAdapter, CinemaTheater, TheaterListResult } from "../src/cinema.js";
import {
  providerFromExternalPlaceLabel,
  resolveTheaterTargets
} from "../src/resolve-theater-targets.js";
import type { CinemaProviderId } from "../src/providers.js";

function theater(provider: CinemaProviderId, id: string, name: string): CinemaTheater {
  const sourceUrl = provider === "toho"
    ? "https://www.tohotheater.jp/theater/find.html"
    : provider === "aeon"
      ? "https://www.aeoncinema.com/theater/"
      : "https://109cinemas.net/";
  return { provider, id, name, sourceUrl };
}

function adapter(provider: CinemaProviderId, list: (query?: string) => Promise<TheaterListResult>): CinemaReadAdapter {
  return {
    listTheaters: list,
    getShowtimes: async () => {
      throw new Error(`unused getShowtimes for ${provider}`);
    }
  };
}

test("external place labels classify only reviewed cinema brands", () => {
  assert.equal(providerFromExternalPlaceLabel("TOHOシネマズ ららぽーと横浜"), "toho");
  assert.equal(providerFromExternalPlaceLabel("イオンシネマ みなとみらい"), "aeon");
  assert.equal(providerFromExternalPlaceLabel("109シネマズ港北"), "109");
  assert.equal(providerFromExternalPlaceLabel("１０９シネマズ プレミアム新宿"), "109");
  assert.equal(providerFromExternalPlaceLabel("ムービル"), "109");
  assert.equal(providerFromExternalPlaceLabel("映画館っぽい別施設"), undefined);
  assert.equal(providerFromExternalPlaceLabel("カフェ TOHOシネマズ風"), undefined);
});

test("area composition re-resolves external labels through provider theater lists in source order", async () => {
  const calls: string[] = [];
  const adapters = new Map<CinemaProviderId, CinemaReadAdapter>([
    ["toho", adapter("toho", async (query) => {
      calls.push(`toho:${query}`);
      return {
        provider: "toho",
        sourceUrl: "https://www.tohotheater.jp/theater/find.html",
        theaters: [theater("toho", "036", "TOHOシネマズ ららぽーと横浜")]
      };
    })],
    ["aeon", adapter("aeon", async (query) => {
      calls.push(`aeon:${query}`);
      return {
        provider: "aeon",
        sourceUrl: "https://www.aeoncinema.com/theater/",
        theaters: [theater("aeon", "minatomirai", "イオンシネマ みなとみらい")]
      };
    })]
  ]);

  const result = await resolveTheaterTargets(
    {
      candidates: [
        { index: 0, label: "TOHOシネマズ ららぽーと横浜" },
        { index: 1, label: "イオンシネマ みなとみらい" }
      ],
      sourceTruncated: true
    },
    (provider) => adapters.get(provider) ?? adapter(provider, async () => ({ provider, sourceUrl: "https://109cinemas.net/", theaters: [] }))
  );

  assert.deepEqual(calls, [
    "toho:TOHOシネマズ ららぽーと横浜",
    "aeon:イオンシネマ みなとみらい"
  ]);
  assert.deepEqual(result.targets, [
    { provider: "toho", theater: "TOHOシネマズ ららぽーと横浜" },
    { provider: "aeon", theater: "イオンシネマ みなとみらい" }
  ]);
  assert.equal(result.sourceTruncated, true);
  assert.equal(result.resolved.length, 2);
  assert.deepEqual(result.unresolved, []);
});

test("unsupported labels are rejected without invoking a provider adapter", async () => {
  let calls = 0;
  const result = await resolveTheaterTargets(
    { candidates: [{ index: 0, label: "横浜ブルク13" }] },
    () => {
      calls += 1;
      throw new Error("must not resolve unsupported provider labels");
    }
  );

  assert.equal(calls, 0);
  assert.deepEqual(result.targets, []);
  assert.equal(result.unresolved[0]?.reason, "UNSUPPORTED_PROVIDER_LABEL");
});

test("zero and ambiguous provider matches remain explicit instead of becoming guessed targets", async () => {
  let count = 0;
  const result = await resolveTheaterTargets(
    {
      candidates: [
        { label: "イオンシネマ 存在しない" },
        { label: "イオンシネマ テスト" }
      ]
    },
    () => adapter("aeon", async () => {
      count += 1;
      return count === 1
        ? { provider: "aeon", sourceUrl: "https://www.aeoncinema.com/theater/", theaters: [] }
        : {
          provider: "aeon",
          sourceUrl: "https://www.aeoncinema.com/theater/",
          theaters: [
            theater("aeon", "test-1", "イオンシネマ テスト1"),
            theater("aeon", "test-2", "イオンシネマ テスト2")
          ]
        };
    })
  );

  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.unresolved.map((item) => item.reason), ["NO_THEATER_MATCH", "AMBIGUOUS_THEATER_MATCH"]);
});

test("provider failure is preserved and later candidates can still resolve", async () => {
  const adapters = new Map<CinemaProviderId, CinemaReadAdapter>([
    ["toho", adapter("toho", async () => {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO UI changed");
    })],
    ["109", adapter("109", async () => ({
      provider: "109",
      sourceUrl: "https://109cinemas.net/",
      theaters: [theater("109", "kohoku", "109シネマズ港北")]
    }))]
  ]);

  const result = await resolveTheaterTargets(
    {
      candidates: [
        { label: "TOHOシネマズ ららぽーと横浜" },
        { label: "109シネマズ港北" }
      ]
    },
    (provider) => adapters.get(provider)!
  );

  assert.deepEqual(result.targets, [{ provider: "109", theater: "109シネマズ港北" }]);
  assert.equal(result.unresolved[0]?.reason, "PROVIDER_FAILURE");
  assert.equal(result.unresolved[0]?.error?.code, "UI_STATE_CHANGED");
});

test("provider theater provenance is revalidated before creating a target", async () => {
  const result = await resolveTheaterTargets(
    { candidates: [{ label: "TOHOシネマズ ららぽーと横浜" }] },
    () => adapter("toho", async () => ({
      provider: "toho",
      sourceUrl: "https://evil.example/theater",
      theaters: [theater("toho", "036", "TOHOシネマズ ららぽーと横浜")]
    }))
  );

  assert.deepEqual(result.targets, []);
  assert.equal(result.unresolved[0]?.reason, "CONTRACT_VIOLATION");
});

test("duplicate verified theaters are returned once and target limit prevents extra provider reads", async () => {
  let calls = 0;
  const toho = theater("toho", "036", "TOHOシネマズ ららぽーと横浜");
  const aeon = theater("aeon", "minatomirai", "イオンシネマ みなとみらい");
  const result = await resolveTheaterTargets(
    {
      candidates: [
        { index: 0, label: "TOHOシネマズ ららぽーと横浜" },
        { index: 1, label: "TOHOシネマズ ららぽーと横浜" },
        { index: 2, label: "イオンシネマ みなとみらい" },
        { index: 3, label: "109シネマズ港北" }
      ],
      limit: 2
    },
    (provider) => adapter(provider, async () => {
      calls += 1;
      if (provider === "toho") {
        return { provider, sourceUrl: "https://www.tohotheater.jp/theater/find.html", theaters: [toho] };
      }
      if (provider === "aeon") {
        return { provider, sourceUrl: "https://www.aeoncinema.com/theater/", theaters: [aeon] };
      }
      return { provider, sourceUrl: "https://109cinemas.net/", theaters: [theater("109", "kohoku", "109シネマズ港北")] };
    })
  );

  assert.equal(calls, 3);
  assert.deepEqual(result.targets, [
    { provider: "toho", theater: "TOHOシネマズ ららぽーと横浜" },
    { provider: "aeon", theater: "イオンシネマ みなとみらい" }
  ]);
  assert.equal(result.unresolved[0]?.reason, "DUPLICATE_TARGET");
  assert.equal(result.unresolved[1]?.reason, "TARGET_LIMIT_REACHED");
  assert.equal(result.limitReached, true);
});
