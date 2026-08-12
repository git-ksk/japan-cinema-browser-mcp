import assert from "node:assert/strict";
import { ChromeProcess } from "../src/browser/chrome-process.js";
import { CinemaBrowserRuntime } from "../src/browser/runtime.js";
import { loadConfig } from "../src/config.js";
import { TohoReadAdapter } from "../src/providers/toho/adapter.js";

const config = loadConfig();
const chrome = new ChromeProcess(config.browser);
const runtime = new CinemaBrowserRuntime(chrome, config.policy.maxReadChars);
const adapter = new TohoReadAdapter(runtime);

try {
  const theaters = await adapter.listTheaters("ららぽーと横浜");
  assert.equal(theaters.theaters.length, 1);
  assert.equal(theaters.theaters[0]?.id, "036");

  const schedule = await adapter.getShowtimes({ theater: "ららぽーと横浜" });
  assert.equal(schedule.provider, "toho");
  assert.equal(schedule.theater.id, "036");
  assert.equal(schedule.dateAvailable, true);
  assert.ok(schedule.availableDates.includes(schedule.date));
  assert.ok(schedule.sourceUrl.startsWith("https://"));
  assert.ok(new URL(schedule.sourceUrl).hostname.endsWith("tohotheater.jp"));

  console.error(`[toho-live-smoke] ${schedule.theater.name} ${schedule.date}: ${schedule.showtimes.length} showtimes`);
} finally {
  await runtime.close();
}
