import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeError } from "../src/browser/runtime.js";
import {
  normalizeTohoDateLabel,
  normalizeTohoTheaterSnapshot
} from "../src/providers/toho/adapter.js";

function theaterRows(count = 20) {
  return Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return {
      id,
      name: `TOHOシネマズ テスト${index + 1}`,
      url: `https://hlo.tohotheater.jp/net/schedule/${id}/TNPI2000J01.do`
    };
  });
}

test("TOHO date labels normalize to Japan calendar dates including year rollover", () => {
  assert.equal(normalizeTohoDateLabel("8/13（木）", "2026-08-13"), "2026-08-13");
  assert.equal(normalizeTohoDateLabel("2026年8月15日", "2026-08-13"), "2026-08-15");
  assert.equal(normalizeTohoDateLabel("1/2（金）", "2026-12-30"), "2027-01-02");
  assert.equal(normalizeTohoDateLabel("not a date", "2026-08-13"), undefined);
});

test("TOHO theater snapshot accepts only reviewed public schedule links and deduplicates identical ids", () => {
  const rows = theaterRows();
  rows.push({ ...rows[0]! });
  rows.push({
    id: "999",
    name: "TOHOシネマズ 外部",
    url: "https://example.com/net/schedule/999/TNPI2000J01.do"
  });
  const result = normalizeTohoTheaterSnapshot({ rows }, "https://www.tohotheater.jp/theater/find.html");
  assert.equal(result.length, 20);
  assert.equal(result[0]?.provider, "toho");
  assert.ok(result.every((theater) => theater.url.startsWith("https://hlo.tohotheater.jp/net/schedule/")));
});

test("TOHO theater snapshot fails closed when the public UI no longer resembles a theater list", () => {
  assert.throws(
    () => normalizeTohoTheaterSnapshot({ rows: theaterRows(4) }, "https://www.tohotheater.jp/theater/find.html"),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});

test("TOHO theater snapshot fails closed on conflicting duplicate theater ids", () => {
  const rows = theaterRows();
  rows.push({
    id: "001",
    name: "TOHOシネマズ 別名",
    url: "https://hlo.tohotheater.jp/net/schedule/001/TNPI2000J01.do"
  });
  assert.throws(
    () => normalizeTohoTheaterSnapshot({ rows }, "https://www.tohotheater.jp/theater/find.html"),
    (error) => error instanceof BrowserRuntimeError && error.code === "UI_STATE_CHANGED"
  );
});
