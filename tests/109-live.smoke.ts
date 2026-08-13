import assert from "node:assert/strict";
import { ChromeProcess } from "../src/browser/chrome-process.js";
import { CinemaBrowserRuntime } from "../src/browser/runtime.js";
import { loadConfig } from "../src/config.js";
import { Cinemas109ReadAdapter } from "../src/providers/109/adapter.js";

const config = loadConfig();
const chrome = new ChromeProcess(config.browser);
const runtime = new CinemaBrowserRuntime(chrome, config.policy.maxReadChars);
const adapter = new Cinemas109ReadAdapter(runtime);

try {
  const theaters = await adapter.listTheaters("港北");
  assert.equal(theaters.theaters.length, 1);
  assert.equal(theaters.theaters[0]?.name, "109シネマズ港北");
  assert.equal(theaters.theaters[0]?.url, "https://109cinemas.net/kohoku/");

  const schedule = await adapter.getShowtimes({ theater: "港北" });
  assert.equal(schedule.provider, "109");
  assert.equal(schedule.theater.name, "109シネマズ港北");
  assert.match(schedule.date, /^20\d{2}-\d{2}-\d{2}$/);
  assert.equal(schedule.dateAvailable, true, "expected today's explicit public schedule link");
  assert.match(schedule.sourceUrl, /^https:\/\/109cinemas\.net\/kohoku\/schedules\/20\d{6}\.html(?:\?|$)/);
  assert.ok(schedule.showtimes.length > 0, "expected at least one rendered public showtime");

  console.error(`[109-live-smoke] ${schedule.theater.name} ${schedule.date}: ${schedule.showtimes.length} showtimes`);
} finally {
  await runtime.close();
}
