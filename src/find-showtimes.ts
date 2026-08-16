import { BrowserRuntimeError } from "./browser/runtime.js";
import {
  SHOWTIME_FORMATS,
  type CinemaReadAdapter,
  type CinemaShowtime,
  type ShowtimeFormat,
  type ShowtimeResult
} from "./cinema.js";
import { ProviderPolicyError, assertOfficialUrl, type CinemaProviderId } from "./providers.js";

export interface FindShowtimesTarget {
  provider: CinemaProviderId;
  theater: string;
}

export interface FindShowtimesQuery {
  targets: FindShowtimesTarget[];
  date?: string;
  movie?: string;
  after?: string;
  before?: string;
  format?: ShowtimeFormat;
}

export interface FindShowtimesFailure {
  target: FindShowtimesTarget;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface FindShowtimesSuccess {
  target: FindShowtimesTarget;
  result: ShowtimeResult;
}

export interface FindShowtimesResult {
  complete: boolean;
  date: string;
  targets: FindShowtimesTarget[];
  successes: FindShowtimesSuccess[];
  failures: FindShowtimesFailure[];
  showtimes: CinemaShowtime[];
}

export type CinemaReadAdapterResolver = (provider: CinemaProviderId) => CinemaReadAdapter;
export type FindShowtimesTargetRunner = <T>(
  target: FindShowtimesTarget,
  task: () => Promise<T>
) => Promise<T>;

export interface FindShowtimesOptions {
  runTarget?: FindShowtimesTargetRunner;
}

const ISO_DATE = /^20\d{2}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const FORMAT_SET = new Set<string>(SHOWTIME_FORMATS);

function tokyoTodayIso(now: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("could not resolve the current Tokyo calendar date");
  return `${year}-${month}-${day}`;
}

function resolvedDate(input: FindShowtimesQuery, now: Date): string {
  const date = input.date ?? tokyoTodayIso(now);
  if (!ISO_DATE.test(date)) throw new Error("find_showtimes date must be YYYY-MM-DD");
  return date;
}

function validateResult(target: FindShowtimesTarget, date: string, result: ShowtimeResult): string | undefined {
  if (result.provider !== target.provider) return "provider identity mismatch";
  if (result.date !== date) return "date identity mismatch";
  if (!result.theater?.id || !result.theater.name) return "resolved theater identity is missing";
  if (result.theater.provider !== target.provider) return "theater provider identity mismatch";
  try {
    assertOfficialUrl(result.sourceUrl, target.provider);
    assertOfficialUrl(result.theater.sourceUrl, target.provider);
  } catch {
    return "result provenance is outside the reviewed provider domain";
  }
  for (const showtime of result.showtimes) {
    if (showtime.provider !== target.provider) return "showtime provider identity mismatch";
    if (showtime.theaterId !== result.theater.id) return "showtime theater identity mismatch";
    if (showtime.date !== result.date) return "showtime date identity mismatch";
    if (!CLOCK_TIME.test(showtime.startTime)) return "showtime startTime is not canonical HH:MM";
    if (showtime.endTime && !CLOCK_TIME.test(showtime.endTime)) return "showtime endTime is not canonical HH:MM";
    if (showtime.formats.some((format) => !FORMAT_SET.has(format))) return "showtime format is outside the canonical vocabulary";
    try {
      assertOfficialUrl(showtime.sourceUrl, target.provider);
    } catch {
      return "showtime provenance is outside the reviewed provider domain";
    }
  }
  return undefined;
}

function normalizedFailure(target: FindShowtimesTarget, error: unknown): FindShowtimesFailure {
  if (error instanceof BrowserRuntimeError) {
    return {
      target,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      }
    };
  }
  if (error instanceof ProviderPolicyError) {
    return { target, error: { code: error.code, message: error.message } };
  }
  return {
    target,
    error: {
      code: "INTERNAL_ERROR",
      message: "The provider read failed unexpectedly. Check the local MCP server logs."
    }
  };
}

function filterShowtimes(showtimes: CinemaShowtime[], input: FindShowtimesQuery): CinemaShowtime[] {
  return showtimes.filter((showtime) => {
    if (input.after && showtime.startTime < input.after) return false;
    if (input.before && showtime.startTime > input.before) return false;
    if (input.format && !showtime.formats.includes(input.format)) return false;
    return true;
  });
}

export async function findShowtimes(
  input: FindShowtimesQuery,
  adapterFor: CinemaReadAdapterResolver,
  now = new Date(),
  options: FindShowtimesOptions = {}
): Promise<FindShowtimesResult> {
  if (input.targets.length < 1 || input.targets.length > 3) {
    throw new Error("find_showtimes requires between 1 and 3 explicit provider/theater targets");
  }
  if (input.after && !CLOCK_TIME.test(input.after)) throw new Error("find_showtimes after must be HH:MM");
  if (input.before && !CLOCK_TIME.test(input.before)) throw new Error("find_showtimes before must be HH:MM");
  if (input.after && input.before && input.after > input.before) {
    throw new Error("find_showtimes after must not be later than before");
  }

  const date = resolvedDate(input, now);
  const successes: FindShowtimesSuccess[] = [];
  const failures: FindShowtimesFailure[] = [];
  const ranked: Array<{ targetIndex: number; showtime: CinemaShowtime }> = [];

  // Intentionally sequential. All providers share one reviewed Chrome/CDP session, so
  // concurrent navigations would race the current page. Concurrency is bounded at 1.
  for (let targetIndex = 0; targetIndex < input.targets.length; targetIndex += 1) {
    const target = input.targets[targetIndex]!;
    try {
      const read = () => adapterFor(target.provider).getShowtimes({
        theater: target.theater,
        date,
        ...(input.movie ? { movie: input.movie } : {})
      });
      const result = options.runTarget
        ? await options.runTarget(target, read)
        : await read();
      const violation = validateResult(target, date, result);
      if (violation) {
        failures.push({
          target,
          error: {
            code: "CONTRACT_VIOLATION",
            message: `Provider result violated the common cinema contract: ${violation}`
          }
        });
        continue;
      }
      const filteredShowtimes = filterShowtimes(result.showtimes, input);
      successes.push({ target, result: { ...result, showtimes: filteredShowtimes } });
      for (const showtime of filteredShowtimes) {
        ranked.push({ targetIndex, showtime });
      }
    } catch (error) {
      if (!(error instanceof BrowserRuntimeError) && !(error instanceof ProviderPolicyError)) {
        console.error("[japan-cinema-browser-mcp] unexpected find_showtimes provider error", {
          provider: target.provider,
          errorName: error instanceof Error ? error.name : "UnknownError"
        });
      }
      failures.push(normalizedFailure(target, error));
    }
  }

  ranked.sort((a, b) =>
    a.showtime.date.localeCompare(b.showtime.date) ||
    a.showtime.startTime.localeCompare(b.showtime.startTime) ||
    a.targetIndex - b.targetIndex ||
    a.showtime.movie.localeCompare(b.showtime.movie, "ja-JP") ||
    (a.showtime.screen ?? "").localeCompare(b.showtime.screen ?? "", "ja-JP")
  );

  return {
    complete: failures.length === 0,
    date,
    targets: input.targets,
    successes,
    failures,
    showtimes: ranked.map((item) => item.showtime)
  };
}
