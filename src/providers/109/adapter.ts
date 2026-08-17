import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";
import type { CinemaReadAdapter, CinemaSeat, CinemaSeatMap, CinemaSeatReadAdapter, CinemaShowtime, CinemaTheater, SeatAvailabilityQuery, SeatAvailabilityResult, ShowtimeFormat, ShowtimeQuery, ShowtimeResult, TheaterListResult } from "../../cinema.js";
import { assertOfficialUrl } from "../../providers.js";

const CINEMAS_109_HOME_URL = "https://109cinemas.net/";
const CINEMAS_109_HOST = "109cinemas.net";
const THEATER_ROUTE = /^\/([a-z0-9-]+)\/$/;
const SCHEDULE_ROUTE = /^\/([a-z0-9-]+)\/schedules\/(20\d{6})\.html$/;
const SEAT_ENTRY_HOST = "cinema.109cinemas.net";
const SEAT_ENTRY_PATH = "/cgi-bin/pc/resv/resv_shw_ppt.cgi";
const MIN_REVIEWED_THEATER_COUNT = 18;
const MAX_REVIEWED_THEATER_COUNT = 32;
const THEATER_READY_ATTEMPTS = 20;
const SCHEDULE_READY_ATTEMPTS = 30;
const READY_POLL_MS = 180;

export interface Cinemas109Theater extends CinemaTheater<"109"> {
  url: string;
}

interface Cinemas109TheaterCandidate extends Cinemas109Theater {
  searchLabels: string[];
}

export interface Cinemas109Showtime extends CinemaShowtime<"109"> {}

interface TheaterSnapshotRow {
  label?: unknown;
  href?: unknown;
  region?: unknown;
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

interface SeatEntrySnapshot {
  matched?: unknown;
  hrefs?: unknown;
}

interface SeatSnapshotRow {
  value?: unknown;
  disabled?: unknown;
  checked?: unknown;
  seatKey?: unknown;
  universal?: unknown;
  group?: unknown;
}

interface SeatSnapshot {
  title?: unknown;
  timerVisible?: unknown;
  selectedSummary?: unknown;
  seats?: unknown;
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
      const group = anchor.closest('dd');
      let region = '';
      if (group) {
        let sibling = group.previousElementSibling;
        while (sibling && sibling.tagName !== 'DT') sibling = sibling.previousElementSibling;
        region = normalize(sibling?.textContent);
      }
      rows.push({ label, href: url.href, region });
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


function seatEntryExpression(showtime: Cinemas109Showtime): string {
  const movie = JSON.stringify(showtime.movie);
  const start = JSON.stringify(showtime.startTime);
  const end = JSON.stringify(showtime.endTime ?? "");
  const screen = JSON.stringify(showtime.screen ?? "");
  return `(() => {
    const movie = ${movie};
    const start = ${start};
    const end = ${end};
    const screen = ${screen};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const hrefs = [];
    let matched = 0;
    for (const article of Array.from(document.querySelectorAll('article')).filter(visible)) {
      const titles = Array.from(article.querySelectorAll('header h2')).filter(visible).map((el) => normalize(el.textContent));
      if (titles.length !== 1 || titles[0] !== movie) continue;
      for (const timetable of Array.from(article.children).filter((el) => el.matches?.('ul.timetable') && visible(el))) {
        const theaterRows = Array.from(timetable.children).filter((el) => el.matches?.('li.theatre') && visible(el));
        if (theaterRows.length !== 1) continue;
        const screenText = normalize(theaterRows[0].textContent);
        const observedScreen = screenText.match(/(?:シアター|THEATER)\\s*([A-Z0-9-]+)/i)?.[1] || '';
        if (screen && observedScreen !== screen) continue;
        for (const row of Array.from(timetable.children).filter((el) => el.matches?.('li:not(.theatre)') && visible(el))) {
          const observedStart = normalize(row.querySelector('time.start')?.textContent).replace(/：/g, ':').padStart(5, '0');
          const observedEnd = normalize(row.querySelector('time.end')?.textContent).replace(/：/g, ':').padStart(5, '0');
          if (observedStart !== start || (end && observedEnd !== end)) continue;
          matched += 1;
          const anchors = Array.from(row.querySelectorAll('a[href]')).filter(visible);
          if (anchors.length === 1) hrefs.push(String(anchors[0].href || ''));
        }
      }
    }
    return { matched, hrefs };
  })()`;
}

const SEAT_MAP_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const body = normalize(document.body.innerText || document.body.textContent);
  const seats = Array.from(document.querySelectorAll('input.seat[type="checkbox"]')).map((el) => ({
    value: String(el.value || ''),
    disabled: Boolean(el.disabled),
    checked: Boolean(el.checked),
    seatKey: String(el.getAttribute('data-seat-key') || ''),
    universal: String(el.getAttribute('data-universal') || ''),
    group: String(el.getAttribute('seat-group') || '')
  }));
  const selected = body.match(/選択座席\\s*[:：]?\\s*([0-9０-９]+)\\s*[／/]\\s*([0-9０-９]+)席/);
  return {
    title: document.title,
    timerVisible: /今から\\s*10分以内に購入が完了しない場合、?\\s*座席が解放されます/.test(body),
    selectedSummary: selected ? selected[0] : '',
    seats
  };
})()`;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalize109TheaterQuery(value: string): string {
  return normalizeText(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^109シネマ(?:ズ)?/i, "")
    .toLocaleLowerCase("ja-JP");
}

function matches109Theater(candidate: Cinemas109TheaterCandidate, query: string): boolean {
  const needle = normalize109TheaterQuery(query);
  if (!needle) return false;
  return candidate.searchLabels.some((label) => normalize109TheaterQuery(label).includes(needle));
}

function public109Theater(candidate: Cinemas109TheaterCandidate): Cinemas109Theater {
  const { searchLabels: _searchLabels, ...theater } = candidate;
  return theater;
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

export function normalize109TheaterSnapshot(snapshot: TheaterSnapshot, sourceUrl: string): Cinemas109TheaterCandidate[] {
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

  const byId = new Map<string, Cinemas109TheaterCandidate>();
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
    if (!id || !normalize109TheaterQuery(name)) continue;
    const existing = byId.get(id);
    if (existing && normalize109TheaterQuery(existing.name) !== normalize109TheaterQuery(name)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas theater route resolves to multiple visible theater identities.", {
        id,
        names: [existing.name, name]
      });
    }
    const region = typeof raw.region === "string" ? normalizeText(raw.region) : "";
    byId.set(id, {
      provider: "109",
      id,
      name,
      url: theaterUrl,
      sourceUrl,
      searchLabels: [name, normalizeText(raw.label), ...(region ? [region] : [])]
    });
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
  const expected = normalize109TheaterQuery(theater.name);
  const observed = uniqueStrings(snapshot.theaterNames, 8).map(normalize109TheaterQuery);
  if (observed.includes(expected)) return true;
  const title = typeof snapshot.title === "string" ? normalize109TheaterQuery(snapshot.title) : "";
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
  return normalize109TheaterQuery(snapshot.title).includes(normalize109TheaterQuery(theater.name));
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


export function review109SeatEntryUrl(value: string, date: string, startTime: string): string {
  let url: URL;
  try { url = assertOfficialUrl(value, "109"); } catch (error) {
    throw new BrowserRuntimeError("URL_NOT_ALLOWED", error instanceof Error ? error.message : "109 Cinemas seat entry URL is not allowed.");
  }
  if (url.hostname !== SEAT_ENTRY_HOST || url.pathname !== SEAT_ENTRY_PATH || url.hash) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat entry URL is outside the reviewed rendered public route.");
  }
  const entries = [...url.searchParams.entries()];
  const allowed = new Set(["ttc", "tsc", "tssc", "ymd", "cs", "stt"]);
  if (entries.length !== 6 || entries.some(([key]) => !allowed.has(key)) || new Set(entries.map(([key]) => key)).size !== 6) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat entry query no longer matches the reviewed public shape.");
  }
  if (!/^\d+$/.test(url.searchParams.get("ttc") ?? "") || !/^\d+$/.test(url.searchParams.get("tsc") ?? "") || !/^\d+$/.test(url.searchParams.get("tssc") ?? "")) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat entry identity query is malformed.");
  }
  if (!/^[A-Za-z0-9_-]*$/.test(url.searchParams.get("cs") ?? "")) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat entry optional public context value is malformed.");
  }
  if (url.searchParams.get("ymd") !== date || url.searchParams.get("stt") !== startTime.replace(":", "")) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat entry URL does not match the requested showtime date/time.", {
      expectedDate: date,
      expectedStartTime: startTime
    });
  }
  return url.href;
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

export function normalize109SeatSnapshot(
  snapshot: SeatSnapshot,
  sourceUrl: string,
  theater: Cinemas109Theater,
  showtime: Cinemas109Showtime,
  observedAt = new Date().toISOString()
): CinemaSeatMap<"109"> {
  const reviewed = review109SeatEntryUrl(sourceUrl, showtime.date, showtime.startTime);
  if (!rawString(snapshot.title).includes("座席選択")) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat-map title is missing from the rendered public surface.");
  }
  if (snapshot.timerVisible !== true) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas 10-minute timed-session notice is missing from the reviewed seat-map surface.");
  }
  const selectedSummary = asciiDigits(rawString(snapshot.selectedSummary));
  const selectedMatch = selectedSummary.match(/選択座席\s*[:：]?\s*(\d+)\s*[／/]\s*(\d+)席/);
  if (!selectedMatch || Number(selectedMatch[1]) !== 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas read-only seat-map entry unexpectedly contains selected seats.", { selectedSummary });
  }
  if (!Array.isArray(snapshot.seats) || snapshot.seats.length < 20 || snapshot.seats.length > 1000) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat-map identity list is missing or implausible.", {
      count: Array.isArray(snapshot.seats) ? snapshot.seats.length : 0
    });
  }
  const ids = new Set<string>();
  const positions = new Set<string>();
  const seats: CinemaSeat[] = [];
  for (const raw of snapshot.seats.slice(0, 1000) as SeatSnapshotRow[]) {
    const value = rawString(raw.value);
    const match = value.match(/^([A-Z]+)\s*-\s*(\d+)$/);
    const key = rawString(raw.seatKey).match(/^(\d+)-(\d+)$/);
    if (!match?.[1] || !match[2] || !key?.[1] || !key[2]) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat identity/layout key became ambiguous.", { value });
    }
    const id = `${match[1]}-${match[2]}`;
    const rowIndex = Number(key[1]) - 1;
    const columnIndex = Number(key[2]) - 1;
    const position = `${rowIndex}:${columnIndex}`;
    if (ids.has(id) || positions.has(position) || rowIndex < 0 || columnIndex < 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat identity/layout position is duplicated or invalid.", { seatId: id, position });
    }
    ids.add(id); positions.add(position);
    const checked = raw.checked === true;
    if (checked) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas read-only seat map unexpectedly contains a checked seat.", { seatId: id });
    }
    const unavailable = raw.disabled === true;
    const universal = rawString(raw.universal) === "1";
    const group = rawString(raw.group);
    seats.push({
      id,
      row: match[1],
      number: match[2],
      state: unavailable ? "unavailable" : "available",
      ...(unavailable ? { unavailableReason: "unknown" as const } : {}),
      attributes: universal ? ["provider:universal"] : [],
      rowIndex,
      columnIndex,
      x: columnIndex,
      y: rowIndex,
      ...(group ? { groupId: `109:${group}` } : {})
    });
  }
  const byRow = new Map<string, CinemaSeat[]>();
  for (const seat of seats) {
    const row = byRow.get(seat.row ?? "") ?? [];
    row.push(seat); byRow.set(seat.row ?? "", row);
  }
  for (const row of byRow.values()) {
    row.sort((a, b) => (a.columnIndex ?? 0) - (b.columnIndex ?? 0));
    for (let i = 1; i < row.length; i += 1) {
      const left = row[i - 1]!, right = row[i]!;
      if (left.columnIndex !== undefined && right.columnIndex !== undefined && right.columnIndex > left.columnIndex + 1) {
        left.rightBoundary = "gap"; right.leftBoundary = "gap";
      }
    }
  }
  return {
    provider: "109",
    theaterId: theater.id,
    theater: theater.name,
    ...(showtime.screen ? { screen: showtime.screen } : {}),
    showtimeIdentity: ["109", theater.id, showtime.date, showtime.movie, showtime.startTime, showtime.endTime ?? "", showtime.screen ?? ""].join("|"),
    seats,
    observedAt,
    sourceUrl: reviewed
  };
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

export class Cinemas109ReadAdapter implements CinemaReadAdapter<"109", Cinemas109Theater, Cinemas109Showtime>, CinemaSeatReadAdapter<"109", Cinemas109Theater, Cinemas109Showtime> {
  constructor(private readonly runtime: CinemaBrowserRuntime) {}

  async listTheaters(query?: string): Promise<TheaterListResult<"109", Cinemas109Theater>> {
    const result = await this.readTheaters();
    const candidates = query?.trim()
      ? result.theaters.filter((theater) => matches109Theater(theater, query))
      : result.theaters;
    return { provider: "109", sourceUrl: result.sourceUrl, theaters: candidates.map(public109Theater) };
  }

  async getShowtimes(input: ShowtimeQuery): Promise<ShowtimeResult<"109", Cinemas109Theater, Cinemas109Showtime>> {
    const theater = await this.resolveTheater(input.theater);
    const date = input.date ?? tokyoTodayIso();
    if (!validIsoDate(date)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas requested date is not a valid calendar date.", { date });
    }

    const opened = await this.runtime.navigateReviewed(theater.url, "109");
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
        theater: public109Theater(theater),
        date,
        dateAvailable: false,
        availableDates,
        sourceUrl: theaterSemantic.url,
        showtimes: []
      };
    }

    const expectedRoute = review109ScheduleUrl(requested.url, theater.id);
    const sourceUrl = await this.runtime.navigateReviewed(expectedRoute.url, "109");
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
      theater: public109Theater(theater),
      date,
      dateAvailable: true,
      availableDates,
      sourceUrl: semantic.url,
      showtimes
    };
  }

  async getSeatAvailability(input: SeatAvailabilityQuery): Promise<SeatAvailabilityResult<"109", Cinemas109Theater, Cinemas109Showtime>> {
    const schedule = await this.getShowtimes({ theater: input.theater, date: input.date, movie: input.movie });
    if (!schedule.dateAvailable) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "109 Cinemas requested seat-availability date is not exposed by the current public schedule.");
    }
    let matches = schedule.showtimes.filter((showtime) => showtime.startTime === input.startTime);
    if (input.screen?.trim()) matches = matches.filter((showtime) => showtime.screen === input.screen!.trim());
    if (matches.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "109 Cinemas showtime did not resolve to one unique rendered schedule row for seat availability.", {
        movie: input.movie,
        startTime: input.startTime,
        screen: input.screen,
        candidates: matches.slice(0, 8).map((showtime) => ({ movie: showtime.movie, startTime: showtime.startTime, screen: showtime.screen }))
      });
    }
    const showtime = matches[0]!;
    if (!showtime.screen) throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat availability requires an observed screen identity.");
    if (showtime.availability === "sold_out" || showtime.availability === "unavailable") {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "109 Cinemas showtime is not currently represented by a sellable seat-map entry.");
    }
    const entry = await this.runtime.evaluateSemanticState<SeatEntrySnapshot>("109", seatEntryExpression(showtime));
    const hrefs = uniqueStrings(entry.value.hrefs, 4);
    if (entry.value.matched !== 1 || hrefs.length !== 1) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas showtime no longer exposes one exact rendered public seat-map href.", {
        matchedRows: entry.value.matched,
        hrefCount: hrefs.length
      });
    }
    const reviewedEntry = review109SeatEntryUrl(hrefs[0]!, showtime.date, showtime.startTime);
    const destination = await this.runtime.navigateReviewed(reviewedEntry, "109");
    if (destination !== reviewedEntry) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "109 Cinemas seat-map navigation changed the exact rendered public entry URL.", {
        expected: reviewedEntry,
        observed: destination
      });
    }
    let semantic = await this.runtime.evaluateSemanticState<SeatSnapshot>("109", SEAT_MAP_EXPRESSION);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (rawString(semantic.value.title).includes("座席選択") && Array.isArray(semantic.value.seats) && semantic.value.seats.length >= 20) break;
      await sleep(READY_POLL_MS);
      semantic = await this.runtime.evaluateSemanticState<SeatSnapshot>("109", SEAT_MAP_EXPRESSION);
    }
    const seatMap = normalize109SeatSnapshot(semantic.value, semantic.url, schedule.theater, showtime);
    return { provider: "109", theater: schedule.theater, showtime, seatMap };
  }

  private async readTheaters(): Promise<{ sourceUrl: string; theaters: Cinemas109TheaterCandidate[] }> {
    const status = await this.runtime.status();
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!isTheaterListUrl(currentUrl)) {
      await this.runtime.navigateReviewed(CINEMAS_109_HOME_URL, "109");
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

  private async resolveTheater(query: string): Promise<Cinemas109TheaterCandidate> {
    const result = await this.readTheaters();
    const needle = normalize109TheaterQuery(query);
    const exact = result.theaters.filter((theater) => normalize109TheaterQuery(theater.name) === needle);
    const candidates = exact.length > 0
      ? exact
      : result.theaters.filter((theater) => matches109Theater(theater, query));
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
