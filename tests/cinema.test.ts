import test from "node:test";
import assert from "node:assert/strict";
import { SHOWTIME_FORMATS } from "../src/cinema.js";

test("common showtime format vocabulary is canonical and duplicate-free", () => {
  assert.equal(new Set(SHOWTIME_FORMATS).size, SHOWTIME_FORMATS.length);
  assert.ok(SHOWTIME_FORMATS.includes("SCREENX"));
  assert.equal(SHOWTIME_FORMATS.some((value) => value === ("SCREEN X" as string)), false);
  assert.equal(SHOWTIME_FORMATS.some((value) => value === ("ULTILA" as string)), false);
});
