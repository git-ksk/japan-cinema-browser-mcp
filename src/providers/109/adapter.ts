import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";
import type { CinemaReadAdapter, CinemaShowtime, CinemaTheater, ShowtimeFormat, ShowtimeQuery, ShowtimeResult, TheaterListResult } from "../../cinema.js";
import { assertOfficialUrl } from "../../providers.js";

const CINEMAS_109_HOME_URL = "https://109cinemas.net/";
const CINEMAS_109_HOST = "109cinemas.net";
const THEATER_ROUTE = /^\/([a-z0-9-]+)\/$/;
const SCHEDULE_ROUTE = /^\/([a-z0-9-]+)\/schedules\/(20\d{6})\.html$/;
const MIN_REVIEWED_THEATER_COUNT = 18;
const MAX_REVIEWED_THEATER_COUNT = 32;
const THEATER_READY_ATTEMPTS = 20;
const SCHEDULE_READY_ATTEMPTS = 30;
const READY_POLL_MS = 180;

export interface Cinemas109Theater extends CinemaTheater<"109"> {
  url: string;
}

export interface Cinemas109Showtime extends CinemaShowtime<"109"> {}

interface TheaterSnapshotRow {
  label?: unknown;
  href?: unknown;
}

interface TheaterSnapshot {
  markerCount?: unknown;
  boundaryCount?: unknown;
  rows?: unknown;
}

interface TheaterDateRow {
  label?: unknown;
  href?: unknown;
}

interface TheaterPageSnapshot {
  title?: unknown;
  theaterNames?: unknown;
  scheduleMarkerCount?: unknown;
  dateRows?: unknown;
  emptySchedule?: unknown;
}

interface ScheduleSnapshotRow {
  movie?: unknown;
  label?: unknown;
  screen?: unknown;
  screenContext?: unknown;
  availability?: unknown;
  context?: unknown;
}

interface ScheduleSnapshot {
  title?: unknown;
  dateHeadings?: unknown;
  showtimes?: unknown;
  ambiguousTimeGroups?: unknown;
  unresolvedGroupCount?: unknown;
  emptySchedule?: unknown;
}

export interface Cinemas109ScheduleRoute {
  url: string;
  theaterId: string;
  date: string;
}

const THEATER_LIST_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const markers = Array.from(document.querySelectorAll('img[alt]'))
    .filter(visible)
    .filter((el) => normalize(el.getAttribute('alt')) === '109シネマズの劇場');
  const marker = markers[0] || null;
  const boundaries = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .filter(visible)
    .filter((el) => normalize(el.textContent) === 'マイページ' && (!marker || before(marker, el)));
  const boundary = boundaries[0] || null;
  const rows = [];
  if (marker && boundary) {
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      if (!visible(anchor) || !before(marker, anchor) || !before(anchor, boundary)) continue;
      const label = normalize(anchor.getAttribute('aria-label') || anchor.textContent);
      if (!label || label.length > 80) continue;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (!/^\\/[a-z0-9-]+\\/$/.test(url.pathname)) continue;
      rows.push({ label, href: url.href });
      if (rows.length >= 40) break;
    }
  }
  return { markerCount: markers.length, boundaryCount: boundaries.length, rows };
})()`;

const THEATER_PAGE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible);
  const theaterNames = headings
    .map((el) => normalize(el.textContent))
    .filter((text) => /^(?:109|１０９)シネマズ/.test(text) || text === 'ムービル')
    .slice(0, 8);
  const scheduleMarkers = [
    ...Array.from(document.querySelectorAll('img[alt]'))
      .filter(visible)
      .filter((el) => /上映スケジュール|SCHEDULE/i.test(normalize(el.getAttribute('alt')))),
    ...Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,p,span'))
      .filter(visible)
      .filter((el) => /^(?:上映スケジュール|SCHEDULE)$/i.test(normalize(el.textContent)))
  ];
  const dateRows = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    if (!visible(anchor)) continue;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { continue; }
    if (!/^\\/[a-z0-9-]+\\/schedules\\/20\\d{6}\\.html$/.test(url.pathname)) continue;
    dateRows.push({
      label: normalize(anchor.getAttribute('aria-label') || anchor.textContent),
      href: url.href
    });
    if (dateRows.length >= 40) break;
  }
  const bodyText = normalize((document.querySelector('main') || document.body)?.innerText || '').slice(0, 12000);
  return {
    title: document.title,
    theaterNames,
    scheduleMarkerCount: scheduleMarkers.length,
    dateRows,
    emptySchedule: /(?:上映スケジュールが未確定|上映スケジュールはありません|上映予定はありません)/.test(bodyText)
  };
})()`;

const SCHEDULE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible);
  const dateHeadings = headings
    .map((el) => normalize(el.textContent))
    .filter((text) => /^20\\d{2}\\/\\d{1,2}\\/\\d{1,2}(?:\\s|（|\\(|$)/.test(text))
    .slice(0, 4);

  const timeValuePattern = /^(?:[01]?\\d|2[0-3])[:：][0-5]\\d$/;
  const timeRangePattern = /(?:[01]?\\d|2[0-3])[:：][0-5]\\d\\s*[~〜～ー–—-]\\s*(?:[01]?\\d|2[0-3])[:：][0-5]\\d/;
  const articles = Array.from(document.querySelectorAll('article'))
    .filter(visible)
    .filter((article) => Array.from(article.children).some((child) => child.matches?.('ul.timetable')));

  const showtimes = [];
  const seen = new Set();
  let ambiguousTimeGroups = 0;
  let unresolvedGroupCount = 0;
  for (const article of articles) {
    const movieNodes = Array.from(article.querySelectorAll('header h2'))
      .filter(visible)
      .map((el) => normalize(el.textContent))
      .filter((text) => text.length >= 2 && text.length <= 260);
    const movie = movieNodes.length === 1 ? movieNodes[0] : '';
    const timetables = Array.from(article.children)
      .filter((child) => child.matches?.('ul.timetable') && visible(child));

    for (const timetable of timetables) {
      const screenRows = Array.from(timetable.children)
        .filter((child) => child.matches?.('li.theatre') && visible(child));
      const screenRow = screenRows.length === 1 ? screenRows[0] : null;
      const screen = screenRow
        ? normalize(screenRow.querySelector('a')?.textContent || screenRow.textContent).slice(0, 80)
        : '';
      const screenContext = screenRow ? normalize(screenRow.textContent).slice(0, 240) : '';
      const rows = Array.from(timetable.children)
        .filter((child) => child.matches?.('li:not(.theatre)') && visible(child));

      for (const row of rows) {
        const rowText = normalize(row.textContent);
        const startNodes = Array.from(row.querySelectorAll('time.start')).filter(visible);
        const endNodes = Array.from(row.querySelectorAll('time.end')).filter(visible);
        if (startNodes.length === 0 && endNodes.length === 0 && !timeRangePattern.test(rowText)) continue;
        if (startNodes.length !== 1 || endNodes.length !== 1) {
          ambiguousTimeGroups += 1;
          continue;
        }
        const start = normalize(startNodes[0]?.textContent);
        const end = normalize(endNodes[0]?.textContent);
        if (!timeValuePattern.test(start) || !timeValuePattern.test(end)) {
          ambiguousTimeGroups += 1;
          continue;
        }
        if (!movie || !screen) unresolvedGroupCount += 1;
        const key = [movie, screen, start, end].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        showtimes.push({
          movie,
          label: start + '~' + end,
          screen,
          screenContext,
          availability: rowText.slice(0, 80),
          context: rowText.slice(0, 180)
        });
        if (showtimes.length >= 220) break;
      }
      if (showtimes.length >= 220) break;
    }
    if (showtimes.length >= 220) break;
  }

  const bodyText = normalize((document.querySelector('main') || document.body)?.innerText || '').slice(0, 16000);
  return {
    title: document.title,
    dateHeadings,
    showtimes,
    ambiguousTimeGroups,
    unresolvedGroupCount,
    emptySchedule: /(?:上映スケジュールが未確定|上映スケジュールはありません|上映予定はありません|上映回はありません)/.test(bodyText)
  };
})()`;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTheaterQuery(value: string): string {
  return normalizeText(value)
    .replace(/^(?:109|１０９)シネマズ\s*/i, "")
    .toLocaleLowerCase("ja-JP");
}

function canonicalTheaterName(label: string): string {
  const normalized = normalizeText(label).replace(/^１０９シネマズ/, "109シネマズ");
  if (normalized === "ムービル" || /^109シネマズ/.test(normalized)) return normalized;
  return `109シネマズ${normalized}`;
}

function validIsoDate(value: string): boolean {
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function tokyoTodayIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function compactDateToIso(value: string): string | undefined {
  if (!/^20\d{6}$/.test(value)) return undefined;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return validIsoDate(iso) ? iso : undefined;
}

function theaterUrlFromValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = assertOfficialUrl(value.trim(), "109");
  } catch {
    return undefined;
  }
  if (url.hostname !== CINEMAS_109_HOST || !THEATER_ROUTE.test(url.pathname) || url.search || url.hash) return undefined;
  return url.href;
}

export function review109ScheduleUrl(value: string, expectedTheaterId?: string): Cinemas109ScheduleRoute {
  let url: URL;
  try {
    url = assertOfficialUrl(value, "109");
  } catch (error) {
    throw new BrowserRuntimeError(
      "URL_NOT_ALLOWED",
      error instanceof Error ? error.message : "109 Cinemas schedule URL is not allowed."
    );
  }
  const match = url.pathname.match(SCHEDULE_ROUTE);
  if (
    url.hostname !== CINEMAS_109_HOST ||
    !match?.[1] ||
    !match[2] ||
    url.hash ||
    (expectedTheaterId && match[1] !== expectedTheaterId)
  ) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule URL is outside the reviewed public theater/date route.", {
      url: value,
      expectedTheaterId
    });
  }
  const date = compactDateToIso(match[2]);
  if (!date) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule URL contains an invalid calendar date.", { url: value });
  }
  return { url: url.href, theaterId: match[1], date };
}

export function normalize109TheaterSnapshot(snapshot: TheaterSnapshot, sourceUrl: string): Cinemas109Theater[] {
  let source: URL;
  try {
    source = assertOfficialUrl(sourceUrl, "109");
  } catch {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater list source is outside the reviewed official boundary.");
  }
  if (
    source.hostname !== CINEMAS_109_HOST ||
    source.pathname !== "/" ||
    source.search ||
    source.hash ||
    snapshot.markerCount !== 1 ||
    typeof snapshot.boundaryCount !== "number" ||
    snapshot.boundaryCount < 1 ||
    !Array.isArray(snapshot.rows)
  ) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater list no longer exposes the reviewed public theater block.");
  }

  const byId = new Map<string, Cinemas109Theater>();
  for (const raw of snapshot.rows.slice(0, 40) as TheaterSnapshotRow[]) {
    if (typeof raw?.label !== "string") continue;
    const name = canonicalTheaterName(raw.label);
    const theaterUrl = theaterUrlFromValue(raw.href);
    if (!theaterUrl) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater block contains a route outside the reviewed public theater shape.", {
        label: normalizeText(raw.label).slice(0, 80),
        href: typeof raw.href === "string" ? raw.href.slice(0, 240) : undefined
      });
    }
    const id = new URL(theaterUrl).pathname.match(THEATER_ROUTE)?.[1];
    if (!id || !normalizeTheaterQuery(name)) continue;
    const existing = byId.get(id);
    if (existing && normalizeTheaterQuery(existing.name) !== normalizeTheaterQuery(name)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater route resolves to multiple visible theater identities.", {
        id,
        names: [existing.name, name]
      });
    }
    byId.set(id, { provider: "109", id, name, url: theaterUrl, sourceUrl });
  }

  const theaters = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (theaters.length < MIN_REVIEWED_THEATER_COUNT || theaters.length > MAX_REVIEWED_THEATER_COUNT) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater list extraction returned an unexpected theater count.", {
      count: theaters.length
    });
  }
  return theaters;
}

function uniqueStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .slice(0, limit)
      .filter((item): item is string => typeof item === "string")
      .map(normalizeText)
      .filter(Boolean)
  )];
}

function theaterIdentityMatches(snapshot: TheaterPageSnapshot, theater: Cinemas109Theater): boolean {
  const expected = normalizeTheaterQuery(theater.name);
  const observed = uniqueStrings(snapshot.theaterNames, 8).map(normalizeTheaterQuery);
  if (observed.includes(expected)) return true;
  const title = typeof snapshot.title === "string" ? normalizeTheaterQuery(snapshot.title) : "";
  return title.includes(expected);
}

function dateLabelMatchesRoute(label: string, date: string): boolean {
  const match = normalizeText(label).match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return true;
  return Number(match[1]) === Number(date.slice(5, 7)) && Number(match[2]) === Number(date.slice(8, 10));
}

export function normalize109TheaterPageSnapshot(
  snapshot: TheaterPageSnapshot,
  theater: Cinemas109Theater,
  sourceUrl: string
): Array<Cinemas109ScheduleRoute & { label: string }> {
  let source: URL;
  let expected: URL;
  try {
    source = assertOfficialUrl(sourceUrl, "109");
    expected = assertOfficialUrl(theater.url, "109");
  } catch {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page no longer matches the reviewed official boundary.");
  }
  if (source.href !== expected.href) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page route changed after theater resolution.", {
      expected: expected.href,
      observed: source.href
    });
  }
  if (!theaterIdentityMatches(snapshot, theater)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page identity does not match the requested theater.", {
      expected: theater.name,
      observed: snapshot.theaterNames,
      title: snapshot.title
    });
  }
  if (typeof snapshot.scheduleMarkerCount !== "number" || snapshot.scheduleMarkerCount < 1) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page is missing the reviewed schedule section marker.");
  }
  if (!Array.isArray(snapshot.dateRows)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page does not expose public schedule date links.");
  }
  if (snapshot.dateRows.length === 0) {
    if (snapshot.emptySchedule === true) return [];
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page has no reviewed schedule date links and no explicit empty state.");
  }

  const byDate = new Map<string, Cinemas109ScheduleRoute & { label: string }>();
  for (const raw of snapshot.dateRows.slice(0, 40) as TheaterDateRow[]) {
    if (typeof raw?.href !== "string") {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule date control is missing its explicit public href.");
    }
    const route = review109ScheduleUrl(raw.href, theater.id);
    const label = typeof raw.label === "string" ? normalizeText(raw.label) : "";
    if (label && !dateLabelMatchesRoute(label, route.date)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas visible date label does not match its public schedule route.", {
        label,
        route: route.url
      });
    }
    const existing = byDate.get(route.date);
    if (existing && existing.url !== route.url) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas exposes multiple public routes for one visible theater/date.", {
        date: route.date,
        routes: [existing.url, route.url]
      });
    }
    byDate.set(route.date, { ...route, label });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeFormats(text: string): ShowtimeFormat[] {
  const checks: Array<[RegExp, ShowtimeFormat]> = [
    [/ULTRA\s*4DX/i, "ULTRA 4DX"],
    [/IMAX\s*(?:レーザー|LASER)/i, "IMAX LASER"],
    [/\bIMAX\b/i, "IMAX"],
    [/\b4DX\b/i, "4DX"],
    [/SCREENX/i, "SCREENX"],
    [/Dolby\s*Atmos|ドルビーアトモス/i, "DOLBY ATMOS"],
    [/SAION\s*[-‐–—]?\s*SR\s*EDITION/i, "SAION SR EDITION"],
    [/\bSAION\b/i, "SAION"],
    [/(?:^|[\s【[(])3D(?:[\s】\])]|$)/i, "3D"],
    [/(?:^|[\s【[(])2D(?:[\s】\])]|$)/i, "2D"]
  ];
  const values: ShowtimeFormat[] = [];
  for (const [pattern, label] of checks) {
    if (pattern.test(text) && !values.includes(label)) values.push(label);
  }
  if (values.includes("ULTRA 4DX")) {
    const index = values.indexOf("4DX");
    if (index >= 0) values.splice(index, 1);
  }
  if (values.includes("IMAX LASER")) {
    const index = values.indexOf("IMAX");
    if (index >= 0) values.splice(index, 1);
  }
  if (values.includes("SAION SR EDITION")) {
    const index = values.indexOf("SAION");
    if (index >= 0) values.splice(index, 1);
  }
  return values;
}

function timeRange(label: string): [string, string] | undefined {
  const match = label.replace(/：/g, ":").match(/((?:[01]?\d|2[0-3]):[0-5]\d)\s*[~〜～ー–—-]\s*((?:[01]?\d|2[0-3]):[0-5]\d)/);
  if (!match?.[1] || !match[2]) return undefined;
  return [match[1].padStart(5, "0"), match[2].padStart(5, "0")];
}

function screenValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeText(value).match(/(?:シアター|THEATER)\s*([A-Z0-9-]+)/i)?.[1];
}

function scheduleDateMatches(snapshot: ScheduleSnapshot, date: string): boolean {
  const observed = uniqueStrings(snapshot.dateHeadings, 4);
  if (observed.length !== 1) return false;
  const normalized = observed[0]!.match(/^(20\d{2})\/(\d{1,2})\/(\d{1,2})/);
  if (!normalized?.[1] || !normalized[2] || !normalized[3]) return false;
  const iso = `${normalized[1]}-${normalized[2].padStart(2, "0")}-${normalized[3].padStart(2, "0")}`;
  return iso === date;
}

function scheduleTitleMatches(snapshot: ScheduleSnapshot, theater: Cinemas109Theater): boolean {
  if (typeof snapshot.title !== "string") return false;
  return normalizeTheaterQuery(snapshot.title).includes(normalizeTheaterQuery(theater.name));
}

export function normalize109ScheduleSnapshot(
  snapshot: ScheduleSnapshot,
  theater: Cinemas109Theater,
  date: string,
  sourceUrl: string
): Cinemas109Showtime[] {
  const route = review109ScheduleUrl(sourceUrl, theater.id);
  if (route.date !== date) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule source date does not match the requested date.", {
      expected: date,
      observed: route.date
    });
  }
  if (!scheduleDateMatches(snapshot, date) || !scheduleTitleMatches(snapshot, theater)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule page identity/date does not match the requested theater/date.", {
      expectedTheater: theater.name,
      expectedDate: date,
      title: snapshot.title,
      observedDates: snapshot.dateHeadings
    });
  }
  if (typeof snapshot.ambiguousTimeGroups === "number" && snapshot.ambiguousTimeGroups > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas rendered time ranges could not be separated into unique showtime rows.", {
      ambiguousTimeGroups: snapshot.ambiguousTimeGroups
    });
  }
  if (typeof snapshot.unresolvedGroupCount === "number" && snapshot.unresolvedGroupCount > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas showtime rows could not be bound to a unique movie and screen.", {
      unresolvedGroupCount: snapshot.unresolvedGroupCount
    });
  }
  if (!Array.isArray(snapshot.showtimes)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas showtime rows are unavailable from the rendered public UI.");
  }
  if (snapshot.showtimes.length === 0) {
    if (snapshot.emptySchedule === true) return [];
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule contains no recognizable showtime rows and no explicit empty state.");
  }

  const result: Cinemas109Showtime[] = [];
  const unresolved: string[] = [];
  for (const raw of snapshot.showtimes.slice(0, 220) as ScheduleSnapshotRow[]) {
    if (typeof raw?.label !== "string") continue;
    const range = timeRange(raw.label);
    if (!range) continue;
    const movie = typeof raw.movie === "string" ? normalizeText(raw.movie) : "";
    const screen = screenValue(raw.screen);
    if (!movie || !screen || /^(?:作品詳細へ|印刷する)$/.test(movie)) {
      unresolved.push(normalizeText(raw.label).slice(0, 120));
      continue;
    }
    const screenContext = typeof raw.screenContext === "string" ? normalizeText(raw.screenContext).slice(0, 220) : "";
    const context = typeof raw.context === "string" ? normalizeText(raw.context).slice(0, 420) : "";
    const availabilityText = typeof raw.availability === "string" ? normalizeText(raw.availability) : "";
    const semanticText = `${movie} ${screenContext} ${context}`;
    const language = /\[字幕\]|字幕|(?:^|[\s\]])SUB(?:\]|TITLED|\s|$)/i.test(semanticText)
      ? "subtitled" as const
      : /\[吹替\]|吹替|(?:^|[\s\]])DUB(?:\]|BED|\s|$)/i.test(semanticText)
        ? "dubbed" as const
        : undefined;
    const availability = /満席|完売|売り切れ/.test(availabilityText)
      ? "sold_out" as const
      : /残席わずか|残りわずか/.test(availabilityText)
        ? "limited" as const
        : /販売終了|販売開始前/.test(availabilityText)
          ? "unavailable" as const
          : "unknown" as const;
    result.push({
      provider: "109",
      theaterId: theater.id,
      theater: theater.name,
      date,
      movie,
      startTime: range[0],
      endTime: range[1],
      formats: normalizeFormats(semanticText),
      ...(language ? { language } : {}),
      screen,
      availability,
      sourceUrl
    });
  }
  if (unresolved.length > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Some 109 Cinemas showtime rows could not be associated with one movie/screen; refusing a partial result.", {
      unresolved: unresolved.slice(0, 8)
    });
  }
  const seen = new Set<string>();
  return result.filter((item) => {
    const key = [item.movie, item.startTime, item.endTime ?? "", item.screen ?? "", item.formats.join(",")].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTheaterListUrl(value: string): boolean {
  try {
    const url = assertOfficialUrl(value, "109");
    return url.hostname === CINEMAS_109_HOST && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function theaterSnapshotReady(snapshot: TheaterSnapshot): boolean {
  return (
    snapshot.markerCount === 1 &&
    typeof snapshot.boundaryCount === "number" &&
    snapshot.boundaryCount >= 1 &&
    Array.isArray(snapshot.rows) &&
    snapshot.rows.length >= MIN_REVIEWED_THEATER_COUNT &&
    snapshot.rows.length <= MAX_REVIEWED_THEATER_COUNT
  );
}

function theaterPageSnapshotReady(snapshot: TheaterPageSnapshot): boolean {
  if (!Array.isArray(snapshot.theaterNames) || snapshot.theaterNames.length === 0) return false;
  if (typeof snapshot.scheduleMarkerCount !== "number" || snapshot.scheduleMarkerCount < 1) return false;
  return (Array.isArray(snapshot.dateRows) && snapshot.dateRows.length > 0) || snapshot.emptySchedule === true;
}

function scheduleSnapshotReady(snapshot: ScheduleSnapshot): boolean {
  if (!Array.isArray(snapshot.dateHeadings) || snapshot.dateHeadings.length === 0) return false;
  if (typeof snapshot.ambiguousTimeGroups === "number" && snapshot.ambiguousTimeGroups > 0) return true;
  if (typeof snapshot.unresolvedGroupCount === "number" && snapshot.unresolvedGroupCount > 0) return true;
  return (Array.isArray(snapshot.showtimes) && snapshot.showtimes.length > 0) || snapshot.emptySchedule === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Cinemas109ReadAdapter implements CinemaReadAdapter<"109", Cinemas109Theater, Cinemas109Showtime> {
  constructor(private readonly runtime: CinemaBrowserRuntime) {}

  async listTheaters(query?: string): Promise<TheaterListResult<"109", Cinemas109Theater>> {
    const result = await this.readTheaters();
    let theaters = result.theaters;
    if (query?.trim()) {
      const needle = normalizeTheaterQuery(query);
      theaters = theaters.filter((theater) => normalizeTheaterQuery(theater.name).includes(needle));
    }
    return { provider: "109", sourceUrl: result.sourceUrl, theaters };
  }

  async getShowtimes(input: ShowtimeQuery): Promise<ShowtimeResult<"109", Cinemas109Theater, Cinemas109Showtime>> {
    const theater = await this.resolveTheater(input.theater);
    const date = input.date ?? tokyoTodayIso();
    if (!validIsoDate(date)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas requested date is not a valid calendar date.", { date });
    }

    const opened = await this.runtime.navigate(theater.url, "109");
    if (opened !== theater.url) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas redirected away from the explicitly resolved theater page.", {
        expected: theater.url,
        actual: opened
      });
    }
    const theaterSemantic = await this.readTheaterPageSemantic();
    const routes = normalize109TheaterPageSnapshot(theaterSemantic.value, theater, theaterSemantic.url);
    const availableDates = routes.map((route) => route.date);
    const requested = routes.find((route) => route.date === date);
    if (!requested) {
      return {
        provider: "109",
        theater,
        date,
        dateAvailable: false,
        availableDates,
        sourceUrl: theaterSemantic.url,
        showtimes: []
      };
    }

    const expectedRoute = review109ScheduleUrl(requested.url, theater.id);
    const sourceUrl = await this.runtime.navigate(expectedRoute.url, "109");
    const actualRoute = review109ScheduleUrl(sourceUrl, theater.id);
    if (
      actualRoute.date !== expectedRoute.date ||
      new URL(actualRoute.url).pathname !== new URL(expectedRoute.url).pathname ||
      new URL(actualRoute.url).search !== new URL(expectedRoute.url).search
    ) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas redirected away from the requested explicit public schedule route.", {
        expected: expectedRoute.url,
        actual: sourceUrl
      });
    }

    const semantic = await this.readScheduleSemantic();
    let showtimes = normalize109ScheduleSnapshot(semantic.value, theater, date, semantic.url);
    if (input.movie?.trim()) {
      const needle = normalizeText(input.movie).toLocaleLowerCase("ja-JP");
      showtimes = showtimes.filter((showtime) => showtime.movie.toLocaleLowerCase("ja-JP").includes(needle));
    }
    return {
      provider: "109",
      theater,
      date,
      dateAvailable: true,
      availableDates,
      sourceUrl: semantic.url,
      showtimes
    };
  }

  private async readTheaters(): Promise<{ sourceUrl: string; theaters: Cinemas109Theater[] }> {
    const status = await this.runtime.status();
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!isTheaterListUrl(currentUrl)) {
      await this.runtime.navigate(CINEMAS_109_HOME_URL, "109");
    }
    let semantic: { url: string; value: TheaterSnapshot } | undefined;
    for (let attempt = 0; attempt < THEATER_READY_ATTEMPTS; attempt += 1) {
      semantic = await this.runtime.evaluateSemanticState<TheaterSnapshot>("109", THEATER_LIST_EXPRESSION);
      if (theaterSnapshotReady(semantic.value)) break;
      await sleep(READY_POLL_MS);
    }
    if (!semantic || !theaterSnapshotReady(semantic.value)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater list did not reach the reviewed semantic ready state.", {
        count: Array.isArray(semantic?.value.rows) ? semantic.value.rows.length : undefined
      });
    }
    return { sourceUrl: semantic.url, theaters: normalize109TheaterSnapshot(semantic.value, semantic.url) };
  }

  private async resolveTheater(query: string): Promise<Cinemas109Theater> {
    const result = await this.readTheaters();
    const needle = normalizeTheaterQuery(query);
    const exact = result.theaters.filter((theater) => normalizeTheaterQuery(theater.name) === needle);
    const candidates = exact.length > 0
      ? exact
      : result.theaters.filter((theater) => normalizeTheaterQuery(theater.name).includes(needle));
    if (candidates.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "109 Cinemas theater name did not resolve to one unique public theater link.", {
        query,
        candidates: candidates.slice(0, 12).map((theater) => theater.name)
      });
    }
    return candidates[0]!;
  }

  private async readTheaterPageSemantic(): Promise<{ url: string; value: TheaterPageSnapshot }> {
    let semantic: { url: string; value: TheaterPageSnapshot } | undefined;
    for (let attempt = 0; attempt < THEATER_READY_ATTEMPTS; attempt += 1) {
      semantic = await this.runtime.evaluateSemanticState<TheaterPageSnapshot>("109", THEATER_PAGE_EXPRESSION);
      if (theaterPageSnapshotReady(semantic.value)) return semantic;
      await sleep(READY_POLL_MS);
    }
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater page did not reach the reviewed schedule-link ready state.", {
      observedTheaterNames: semantic?.value.theaterNames,
      dateLinkCount: Array.isArray(semantic?.value.dateRows) ? semantic.value.dateRows.length : undefined
    });
  }

  private async readScheduleSemantic(): Promise<{ url: string; value: ScheduleSnapshot }> {
    let semantic: { url: string; value: ScheduleSnapshot } | undefined;
    for (let attempt = 0; attempt < SCHEDULE_READY_ATTEMPTS; attempt += 1) {
      semantic = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("109", SCHEDULE_EXPRESSION);
      if (scheduleSnapshotReady(semantic.value)) return semantic;
      await sleep(READY_POLL_MS);
    }
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas schedule did not reach a recognizable rendered semantic state.", {
      observedDates: semantic?.value.dateHeadings,
      showtimeCount: Array.isArray(semantic?.value.showtimes) ? semantic.value.showtimes.length : undefined
    });
  }
}
