import assert from "node:assert/strict";
import { ChromeProcess } from "../src/browser/chrome-process.js";
import { CinemaBrowserRuntime } from "../src/browser/runtime.js";
import { loadConfig } from "../src/config.js";
import { AeonReadAdapter } from "../src/providers/aeon/adapter.js";

const config = loadConfig();
const chrome = new ChromeProcess(config.browser);
const runtime = new CinemaBrowserRuntime(chrome, config.policy.maxReadChars);
const adapter = new AeonReadAdapter(runtime);

try {
  const theaters = await adapter.listTheaters("みなとみらい");
  assert.equal(theaters.theaters.length, 1);
  assert.equal(theaters.theaters[0]?.name, "イオンシネマ みなとみらい");

  const schedule = await adapter.getShowtimes({ theater: "みなとみらい" });
  assert.equal(schedule.provider, "aeon");
  assert.equal(schedule.theater.name, "イオンシネマ みなとみらい");
  assert.match(schedule.date, /^20\d{2}-\d{2}-\d{2}$/);
  assert.ok(schedule.sourceUrl.startsWith("https://theater.aeoncinema.com/theaters/"));
  assert.equal(new URL(schedule.sourceUrl).hostname, "theater.aeoncinema.com");
  assert.ok(schedule.showtimes.length > 0, "expected at least one rendered public showtime");

  console.error(`[aeon-live-smoke] ${schedule.theater.name} ${schedule.date}: ${schedule.showtimes.length} showtimes`);
} finally {
  await runtime.close();
}
