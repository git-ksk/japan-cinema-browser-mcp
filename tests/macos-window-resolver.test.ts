import test from "node:test";
import assert from "node:assert/strict";
import { parseExactMacOSWindowId } from "../src/browser/macos-window-resolver.js";

test("macOS exact-window id parser accepts only one positive CGWindowID", () => {
  assert.equal(parseExactMacOSWindowId("24886\n"), 24886);
  assert.equal(parseExactMacOSWindowId("0"), undefined);
  assert.equal(parseExactMacOSWindowId("-1"), undefined);
  assert.equal(parseExactMacOSWindowId("12 13"), undefined);
  assert.equal(parseExactMacOSWindowId("4294967296"), undefined);
  assert.equal(parseExactMacOSWindowId("window=12"), undefined);
});
