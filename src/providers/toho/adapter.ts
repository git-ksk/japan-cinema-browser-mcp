import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";
import type {
  CinemaReadAdapter,
  CinemaSeat,
  CinemaSeatMap,
  CinemaSeatReadAdapter,
  CinemaShowtime,
  CinemaTheater,
  SeatAvailabilityQuery,
  SeatAvailabilityResult,
  ShowtimeFormat,
  ShowtimeQuery,
  ShowtimeResult,
  TheaterListResult
} from "../../cinema.js";
import { assertOfficialUrl } from "../../providers.js";

const TOHO_THEATER_LIST_URL = "https://www.tohotheater.jp/theater/find.html";
const TOHO_SCHEDULE_PATH = /^\/net\/schedule\/(\d{3})\/TNPI2000J01\.do$/;
const TOHO_PROMOTION_PATH = /^\/net\/ticket\/(\d{3})\/TNPI2040J0[34]\.do$/;
const TOHO_SEAT_PATH = /^\/net\/ticket\/(\d{3})\/TNPI2010J01\.do$/;
const MIN_THEATER_SCHEDULE_LINKS = 20;
const TOHO_SALE_STATE_SETTLE_ATTEMPTS = 16;
const TOHO_SALE_STATE_SETTLE_POLL_MS = 180;

export interface TohoTheater extends CinemaTheater<"toho"> {
  aliases: string[];
  url: string;
}

export interface TohoShowtime extends CinemaShowtime<"toho"> {}

interface TheaterSnapshotRow {
  id?: unknown;
  name?: unknown;
  url?: unknown;
}

interface TheaterSnapshot {
  rows?: unknown;
}

interface TheaterRegionExpansionState {
  regionCount?: unknown;
  visibleScheduleLinks?: unknown;
}

interface DateClickState {
  matched?: unknown;
  clicked?: unknown;
}

interface ScheduleDateCandidate {
  label?: unknown;
  selected?: unknown;
  clickable?: unknown;
}

interface ShowtimeSnapshotRow {
  label?: unknown;
  titleCandidates?: unknown;
  context?: unknown;
}


interface SeatEntrySnapshot {
  matched?: unknown;
  labels?: unknown;
}

interface PromotionSnapshot {
  title?: unknown;
  exactNonMemberControls?: unknown;
  sensitiveFields?: unknown;
}

export interface TohoSeatSnapshotRow {
  id?: unknown;
  row?: unknown;
  number?: unknown;
  src?: unknown;
  alt?: unknown;
  onclick?: unknown;
  x?: unknown;
  y?: unknown;
}

export interface TohoSeatSnapshot {
  title?: unknown;
  selectedSummary?: unknown;
  standardCapacity?: unknown;
  wheelchairCapacity?: unknown;
  gridX?: unknown;
  screenMarker?: unknown;
  seats?: unknown;
}

interface TohoScreenMarkerSnapshot {
  id?: unknown;
  className?: unknown;
  imageUrl?: unknown;
  backgroundPosition?: unknown;
  rootTop?: unknown;
  seatMinTop?: unknown;
}

interface ScheduleSnapshot {
  theaterNames?: unknown;
  scheduleHeadingCount?: unknown;
  dates?: unknown;
  showtimes?: unknown;
  emptySchedule?: unknown;
}

const THEATER_LIST_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const rows = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    if (!visible(anchor)) continue;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { continue; }
    const match = url.pathname.match(/^\\/net\\/schedule\\/(\\d{3})\\/TNPI2000J01\\.do$/);
    if (!match) continue;
    const raw = normalize(anchor.innerText || anchor.textContent);
    const name = raw.replace(/\\s*TOHO\\s+CINEMAS\\b.*$/i, '').trim();
    if (!/^TOHOシネマズ\\s+/.test(name)) continue;
    rows.push({ id: match[1], name, url: url.href });
  }
  return { rows: rows.slice(0, 160) };
})()`;

const EXPAND_THEATER_REGIONS_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const rendered = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const schedulePath = /^\\/net\\/schedule\\/\\d{3}\\/TNPI2000J01\\.do$/;
  const regionPrefixes = ['北海道地区', '東北地区', '関東地区', '中部地区', '関西地区', '中国地区', '四国地区', '九州地区'];
  const headings = Array.from(document.querySelectorAll('h3.theater-list-title.js-toggle-button'))
    .filter((el) => {
      if (!rendered(el)) return false;
      const label = normalize(el.textContent);
      return regionPrefixes.some((prefix) => label.startsWith(prefix));
    });
  const regions = headings.map((heading) => {
    const panel = heading.nextElementSibling;
    const validPanel = panel && panel.matches('.theater-list-toggle-panel.js-toggle-panel') ? panel : null;
    return { heading, panel: validPanel };
  });
  const scheduleLinksInOpenPanels = () => {
    let count = 0;
    for (const { panel } of regions) {
      if (!panel || !rendered(panel)) continue;
      for (const anchor of Array.from(panel.querySelectorAll('a[href]'))) {
        try {
          const url = new URL(anchor.href, location.href);
          if (schedulePath.test(url.pathname)) count += 1;
        } catch {}
      }
    }
    return count;
  };
  if (scheduleLinksInOpenPanels() < ${MIN_THEATER_SCHEDULE_LINKS}) {
    for (const { heading, panel } of regions) {
      if (!panel || rendered(panel)) continue;
      heading.click();
    }
  }
  return {
    regionCount: regions.filter(({ panel }) => Boolean(panel)).length,
    visibleScheduleLinks: scheduleLinksInOpenPanels()
  };
})()`;

const SCHEDULE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible);
  const scheduleHeadings = headings.filter((el) => /^上映スケジュール(?:\\s|$)/.test(normalize(el.textContent)));
  const scheduleHeading = scheduleHeadings[0] || null;
  const boundary = scheduleHeading
    ? headings.find((el) => before(scheduleHeading, el) && /^この劇場の公開予定作品/.test(normalize(el.textContent))) || null
    : null;
  const inScheduleRange = (el) => !scheduleHeading || (before(scheduleHeading, el) && (!boundary || before(el, boundary)));

  const theaterNames = headings
    .map((el) => normalize(el.textContent))
    .filter((text) => /^TOHOシネマズ\\s+/.test(text))
    .slice(0, 4);

  const dateItems = Array.from(document.querySelectorAll('.schedule-tab-wrapper .schedule-tab-item'))
    .filter(visible)
    .map((el) => {
      const dateNode = el.querySelector('.schedule-tab-dates');
      return {
        label: normalize(dateNode?.textContent),
        selected: el.classList.contains('is-selected'),
        clickable: !el.classList.contains('is-selected')
      };
    })
    .filter(({ label }) => label.length > 0 && label.length <= 48);
  const dates = [];
  const dateSeen = new Set();
  for (const item of dateItems) {
    if (dateSeen.has(item.label)) continue;
    dateSeen.add(item.label);
    dates.push(item);
    if (dates.length >= 40) break;
  }

  const titleRejected = /^(?:上映スケジュール|この劇場の公開予定作品|販売期間外|購入|詳細|字幕|吹替|IMAX|MX4D|TCX|SCREEN\\s*X|Dolby|ATMOS|3D|2D|轟音|PREMIUM\\s+THEATER)$/i;
  const titleCandidate = (text) => text.length >= 2 && text.length <= 180 && !titleRejected.test(text) && !/^(?:\\d{1,2}[.:：]\\d{2})/.test(text);
  const titleCandidatesFor = (item) => {
    const section = item.closest('.schedule-body-section-item');
    if (!section || !visible(section) || !inScheduleRange(section)) return [];
    const result = [];
    const seen = new Set();
    const selectorGroups = [
      'h3,h4,h5,h6,[role="heading"]',
      '[class*="title" i],[class*="movie" i],[class*="film" i]'
    ];
    for (const selectors of selectorGroups) {
      const nodes = Array.from(section.querySelectorAll(selectors))
        .filter((el) => visible(el) && inScheduleRange(el) && before(el, item))
        .map((el) => normalize(el.textContent))
        .filter(titleCandidate);
      for (const text of nodes) {
        if (seen.has(text)) continue;
        seen.add(text);
        result.push(text);
        if (result.length >= 5) return result;
      }
    }
    return result;
  };
  const contextFor = (item) => {
    const ownText = normalize(item.innerText || item.textContent);
    if (ownText.length >= 8 && ownText.length <= 650) return ownText;
    let parent = item.parentElement;
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
      const text = normalize(parent.innerText || parent.textContent);
      if (text.length >= 8 && text.length <= 650) return text;
    }
    return ownText.slice(0, 240);
  };

  const timePattern = /(?:^|\\D)((?:[01]?\\d|2[0-3])[:：][0-5]\\d)(?!\\d)/;
  const rows = Array.from(document.querySelectorAll('.schedule-body-section-item .schedule-item'))
    .filter((el) => visible(el) && inScheduleRange(el))
    .map((el) => {
      const start = normalize(el.querySelector('.time .start')?.textContent);
      const end = normalize(el.querySelector('.time .end')?.textContent);
      const timeNode = el.querySelector('.time');
      const label = start && end
        ? start + ' ～ ' + end
        : normalize(timeNode?.textContent || el.getAttribute('aria-label') || el.textContent);
      return { el, label };
    })
    .filter(({ label }) => label.length > 0 && label.length <= 160 && timePattern.test(label));
  const showtimes = [];
  const showtimeSeen = new Set();
  for (const item of rows) {
    const titles = titleCandidatesFor(item.el);
    const key = item.label + '|' + titles.join('|');
    if (showtimeSeen.has(key)) continue;
    showtimeSeen.add(key);
    showtimes.push({ label: item.label, titleCandidates: titles, context: contextFor(item.el) });
    if (showtimes.length >= 160) break;
  }

  const rangeText = scheduleHeading
    ? normalize((scheduleHeading.parentElement || scheduleHeading).innerText || scheduleHeading.textContent).slice(0, 2500)
    : '';
  return {
    theaterNames,
    scheduleHeadingCount: scheduleHeadings.length,
    dates,
    showtimes,
    emptySchedule: /(?:上映スケジュールはありません|上映予定はありません|上映回はありません)/.test(rangeText)
  };
})()`;

const PROMOTION_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
  };
  const controls = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]'))
    .filter(visible)
    .filter((el) => normalize(el.getAttribute('aria-label') || el.value || el.textContent) === 'ログインせずに購入する');
  const sensitiveFields = Array.from(document.querySelectorAll('input')).filter((el) => {
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    const label = normalize(el.getAttribute('aria-label') || el.getAttribute('name') || el.id);
    return type === 'password' || autocomplete === 'one-time-code' || /otp|認証コード|verification/i.test(label);
  });
  return { title: document.title, exactNonMemberControls: controls.length, sensitiveFields: sensitiveFields.length };
})()`;

export const TOHO_SEAT_MAP_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const root = document.querySelector('#screen-list-frame-inner');
  if (!root) return { title: document.title, seats: [], gridX: [] };
  const seats = [];
  for (const img of Array.from(root.querySelectorAll('img[id]')).filter(visible)) {
    const id = String(img.id || '').trim();
    const match = id.match(/^([A-Z]+)-(\\d+)$/);
    if (!match) continue;
    const rect = img.getBoundingClientRect();
    let src = '';
    try { src = new URL(img.src, location.href).pathname.split('/').pop() || ''; } catch {}
    seats.push({
      id,
      row: match[1],
      number: match[2],
      src,
      alt: String(img.getAttribute('alt') || '').trim(),
      onclick: String(img.getAttribute('onclick') || '').trim(),
      x: rect.x,
      y: rect.y
    });
  }
  const gridX = [...new Set(Array.from(root.querySelectorAll('img')).filter(visible).map((img) => img.getBoundingClientRect().x))].sort((a, b) => a - b);
  const body = normalize(document.body.innerText || document.body.textContent);
  const capacity = body.match(/(\\d+)\\s*席\\s*\\+\\s*(\\d+)\\s*車いす席/);
  const screenRoot = document.querySelector('#screen-defimg.screen-map');
  let screenMarker = null;
  if (screenRoot) {
    const screenRect = screenRoot.getBoundingClientRect();
    const style = getComputedStyle(screenRoot);
    const background = String(style.backgroundImage || '');
    let backgroundUrl = '';
    if (background.startsWith('url("') && background.endsWith('")')) backgroundUrl = background.slice(5, -2);
    else if (background.startsWith("url('") && background.endsWith("')")) backgroundUrl = background.slice(5, -2);
    else if (background.startsWith('url(') && background.endsWith(')')) backgroundUrl = background.slice(4, -1);
    let imageUrl = '';
    if (backgroundUrl) {
      try { imageUrl = new URL(backgroundUrl, location.href).href; } catch {}
    }
    const seatTops = seats.map((seat) => seat.y).filter(Number.isFinite);
    screenMarker = {
      id: screenRoot.id,
      className: String(screenRoot.className || ''),
      imageUrl,
      backgroundPosition: String(style.backgroundPosition || ''),
      rootTop: screenRect.top,
      seatMinTop: seatTops.length ? Math.min(...seatTops) : null
    };
  }
  return {
    title: document.title,
    selectedSummary: normalize(document.querySelector('#seatList1')?.textContent),
    standardCapacity: capacity ? Number(capacity[1]) : null,
    wheelchairCapacity: capacity ? Number(capacity[2]) : null,
    gridX,
    screenMarker,
    seats
  };
})()`;

function seatEntryExpression(showtime: TohoShowtime): string {
  const start = JSON.stringify(showtime.startTime);
  const end = JSON.stringify(showtime.endTime ?? "");
  const screen = JSON.stringify(showtime.screen ?? "");
  return `(() => {
    const start = ${start};
    const end = ${end};
    const screen = ${screen};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const asciiDigits = (value) => normalize(value).replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
    };
    const rows = Array.from(document.querySelectorAll('.schedule-body-section-item .schedule-item')).filter(visible);
    const matched = rows.filter((row) => {
      const observedStart = normalize(row.querySelector('.time .start')?.textContent).replace(/：/g, ':').padStart(5, '0');
      const observedEnd = normalize(row.querySelector('.time .end')?.textContent).replace(/：/g, ':').padStart(5, '0');
      const context = asciiDigits(row.innerText || row.textContent).replace(/\\s+/g, '');
      if (observedStart !== start) return false;
      if (end && observedEnd !== end) return false;
      if (screen && !context.includes('スクリーン' + screen) && !context.toUpperCase().includes('SCREEN' + screen)) return false;
      return true;
    });
    const labels = [];
    for (const row of matched) {
      const controls = Array.from(row.querySelectorAll('a.wrapper')).filter(visible);
      if (controls.length !== 1) continue;
      const label = normalize(controls[0].getAttribute('aria-label') || controls[0].textContent);
      const href = String(controls[0].getAttribute('href') || '');
      if (!/販売中/.test(label) || !/^javascript:ScheduleUtils\\.purchaseTicket\\(/.test(href)) continue;
      labels.push(label);
    }
    return { matched: matched.length, labels };
  })()`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
}

function normalizeTheaterQuery(value: string): string {
  return normalizeText(value).replace(/^TOHOシネマズ\s*/i, "").toLocaleLowerCase("ja-JP");
}

function routeKey(url: URL): string {
  return url.pathname;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map(normalizeText).filter(Boolean).slice(0, limit);
}

function countValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function tokyoTodayIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const take = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${take("year")}-${take("month")}-${take("day")}`;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeTohoDateLabel(label: string, referenceIso = tokyoTodayIso()): string | undefined {
  const normalized = normalizeText(label).replace(/：/g, ":");
  const full = normalized.match(/(20\d{2})[.\/年-](\d{1,2})[.\/月-](\d{1,2})(?:日)?/);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (validCalendarDate(year, month, day)) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return undefined;
  }
  const short = normalized.match(/(?:^|\s)(\d{1,2})[.\/月-](\d{1,2})(?:日)?(?:\s|\(|（|$)/);
  if (!short) return undefined;
  const month = Number(short[1]);
  const day = Number(short[2]);
  const reference = new Date(`${referenceIso}T00:00:00Z`);
  if (Number.isNaN(reference.getTime())) return undefined;
  const refYear = reference.getUTCFullYear();
  const candidates = [refYear - 1, refYear, refYear + 1]
    .map((year) => {
      if (!validCalendarDate(year, month, day)) return undefined;
      const date = new Date(Date.UTC(year, month - 1, day));
      return { year, distance: Math.abs(date.getTime() - reference.getTime()) };
    })
    .filter((value): value is { year: number; distance: number } => Boolean(value))
    .sort((a, b) => a.distance - b.distance);
  const chosen = candidates[0];
  if (!chosen || chosen.distance > 45 * 24 * 60 * 60 * 1000) return undefined;
  return `${chosen.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeTohoTheaterSnapshot(snapshot: TheaterSnapshot, sourceUrl: string): TohoTheater[] {
  if (!Array.isArray(snapshot.rows)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO theater list did not expose the reviewed public theater-link structure.");
  }
  const groups = new Map<string, { id: string; url: string; aliases: Set<string> }>();
  for (const raw of snapshot.rows.slice(0, 160) as TheaterSnapshotRow[]) {
    if (typeof raw?.id !== "string" || typeof raw.name !== "string" || typeof raw.url !== "string") continue;
    let url: URL;
    try { url = assertOfficialUrl(raw.url, "toho"); } catch { continue; }
    const pathMatch = url.pathname.match(TOHO_SCHEDULE_PATH);
    if (!pathMatch || pathMatch[1] !== raw.id) continue;
    const name = normalizeText(raw.name);
    if (!/^TOHOシネマズ\s+/.test(name)) continue;
    const existing = groups.get(raw.id);
    if (existing && routeKey(new URL(existing.url)) !== routeKey(url)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO theater id points to conflicting public schedule routes.", { theaterId: raw.id });
    }
    const group = existing ?? { id: raw.id, url: url.href, aliases: new Set<string>() };
    group.aliases.add(name);
    groups.set(raw.id, group);
  }
  const theaters = [...groups.values()].map((group): TohoTheater => {
    const aliases = [...group.aliases].sort((a, b) => a.localeCompare(b, "ja"));
    return {
      provider: "toho",
      id: group.id,
      name: aliases.join(" / "),
      aliases,
      url: group.url,
      sourceUrl
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (theaters.length < MIN_THEATER_SCHEDULE_LINKS) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO theater list extraction returned too few schedule groups; the public UI may have changed.", { count: theaters.length });
  }
  return theaters;
}

function normalizedFormats(text: string): ShowtimeFormat[] {
  const checks: Array<[RegExp, ShowtimeFormat]> = [
    [/IMAX\s*(?:レーザー|LASER)/i, "IMAX LASER"],
    [/\bIMAX\b/i, "IMAX"],
    [/Dolby\s*Cinema|ドルビーシネマ/i, "DOLBY CINEMA"],
    [/MX4D/i, "MX4D"],
    [/SCREEN\s*X/i, "SCREENX"],
    [/DTS\s*:?\s*X/i, "DTS:X"],
    [/ATMOS|アトモス/i, "DOLBY ATMOS"],
    [/\bTCX\b/i, "TCX"],
    [/PREMIUM\s+THEATER|プレミアムシアター/i, "PREMIUM THEATER"],
    [/轟音/, "GO-ON"],
    [/(?:^|[\s【\[(])3D(?:[\s】\])]|$)/i, "3D"]
  ];
  const values: ShowtimeFormat[] = [];
  for (const [pattern, label] of checks) {
    if (pattern.test(text) && !values.includes(label)) values.push(label);
  }
  if (values.includes("IMAX LASER")) return values.filter((value) => value !== "IMAX");
  return values;
}

function chooseMovieTitle(value: unknown): string | undefined {
  const candidates = stringArray(value, 5);
  const rejected = /^(?:上映スケジュール|この劇場の公開予定作品|販売期間外|購入|詳細|字幕|吹替|IMAX(?:レーザー)?|MX4D|TCX|SCREEN\s*X|Dolby(?:\s*Cinema)?|ATMOS|3D|2D|轟音|PREMIUM\s+THEATER)$/i;
  return candidates.find((candidate) => candidate.length >= 2 && candidate.length <= 180 && !rejected.test(candidate) && !/^TOHOシネマズ\s+/.test(candidate));
}

function timeParts(label: string): string[] {
  const normalized = label.replace(/：/g, ":");
  const first = normalized.match(/(?:^|\D)((?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)/)?.[1];
  if (!first) return [];
  const start = first.padStart(5, "0");
  const range = normalized.match(/((?:[01]?\d|2[0-3]):[0-5]\d)\s*(?:~|〜|～|–|—|-|→)\s*((?:[01]?\d|2[0-3]):[0-5]\d)/);
  if (!range?.[1] || !range[2] || range[1].padStart(5, "0") !== start) return [start];
  return [start, range[2].padStart(5, "0")];
}

function scheduleIdentityMatches(theater: TohoTheater, observedNames: string[]): boolean {
  if (observedNames.length !== 1) return false;
  const observed = normalizeTheaterQuery(observedNames[0]!);
  return theater.aliases.every((alias) => observed.includes(normalizeTheaterQuery(alias)));
}

function assertScheduleIdentity(snapshot: ScheduleSnapshot, theater: TohoTheater, sourceUrl: string): void {
  if (snapshot.scheduleHeadingCount !== 1) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule heading is missing or ambiguous.", { count: snapshot.scheduleHeadingCount });
  }
  let observedUrl: URL;
  let expectedUrl: URL;
  try {
    observedUrl = assertOfficialUrl(sourceUrl, "toho");
    expectedUrl = assertOfficialUrl(theater.url, "toho");
  } catch {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule source URL no longer matches the reviewed official provider boundary.");
  }
  if (routeKey(observedUrl) !== routeKey(expectedUrl)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule route changed after the theater was resolved.", {
      expected: routeKey(expectedUrl),
      observed: routeKey(observedUrl)
    });
  }
  const theaterNames = stringArray(snapshot.theaterNames, 4).filter((name) => /^TOHOシネマズ\s+/.test(name));
  if (!scheduleIdentityMatches(theater, theaterNames)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule page theater identity does not match the requested theater group.", { expected: theater.aliases, observed: theaterNames });
  }
}

function allShowtimesLookLikeSalePlaceholder(snapshot: ScheduleSnapshot): boolean {
  if (!Array.isArray(snapshot.showtimes) || snapshot.showtimes.length === 0) return false;
  const rows = snapshot.showtimes.slice(0, 160) as ShowtimeSnapshotRow[];
  let recognized = 0;
  for (const raw of rows) {
    if (typeof raw?.label !== "string" || typeof raw.context !== "string") return false;
    if (timeParts(normalizeText(raw.label)).length === 0) return false;
    recognized += 1;
    if (!/販売期間外/.test(normalizeText(raw.context))) return false;
  }
  return recognized > 0;
}

function normalizeScheduleRows(snapshot: ScheduleSnapshot, theater: TohoTheater, date: string, sourceUrl: string): TohoShowtime[] {
  assertScheduleIdentity(snapshot, theater, sourceUrl);
  if (!Array.isArray(snapshot.showtimes)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule rows are unavailable from the rendered public UI.");
  }
  if (snapshot.showtimes.length === 0 && snapshot.emptySchedule !== true) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule page contains no recognizable rendered showtime rows and no explicit empty-schedule state.");
  }
  const result: TohoShowtime[] = [];
  const unresolved: string[] = [];
  for (const raw of snapshot.showtimes.slice(0, 160) as ShowtimeSnapshotRow[]) {
    if (typeof raw?.label !== "string") continue;
    const label = normalizeText(raw.label);
    const times = timeParts(label);
    if (times.length === 0) continue;
    const movie = chooseMovieTitle(raw.titleCandidates);
    if (!movie) {
      unresolved.push(label.slice(0, 120));
      continue;
    }
    const context = typeof raw.context === "string" ? normalizeText(raw.context).slice(0, 650) : "";
    const semanticText = `${movie} ${context}`;
    const screenMatch = normalizeAsciiDigits(semanticText).match(/(?:スクリーン|SCREEN)\s*(?:No\.?\s*)?(\d{1,2}[A-Z]?)/i);
    const language = /字幕|SUBTITLED/i.test(semanticText)
      ? "subtitled" as const
      : /吹替|DUBBED/i.test(semanticText)
        ? "dubbed" as const
        : undefined;
    const availability = /販売期間外/.test(semanticText)
      ? "unavailable" as const
      : /完売|売(?:り)?切れ/.test(semanticText)
        ? "sold_out" as const
        : /残(?:席|り).*(?:わずか|少)/.test(semanticText)
          ? "limited" as const
          : "unknown" as const;
    result.push({
      provider: "toho",
      theaterId: theater.id,
      theater: theater.name,
      date,
      movie,
      startTime: times[0]!,
      ...(times[1] ? { endTime: times[1] } : {}),
      formats: normalizedFormats(semanticText),
      ...(language ? { language } : {}),
      ...(screenMatch?.[1] ? { screen: screenMatch[1] } : {}),
      availability,
      sourceUrl
    });
  }
  if (unresolved.length > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Some TOHO rendered showtime rows could not be associated with one movie title; refusing a partial ambiguous result.", { unresolved: unresolved.slice(0, 8) });
  }
  const seen = new Set<string>();
  return result.filter((item) => {
    const key = [item.movie, item.startTime, item.endTime ?? "", item.formats.join(","), item.screen ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDateCandidates(snapshot: ScheduleSnapshot, referenceIso = tokyoTodayIso()): Array<{ label: string; date: string; selected: boolean; clickable: boolean }> {
  if (!Array.isArray(snapshot.dates)) return [];
  const result: Array<{ label: string; date: string; selected: boolean; clickable: boolean }> = [];
  const seen = new Set<string>();
  for (const raw of snapshot.dates.slice(0, 40) as ScheduleDateCandidate[]) {
    if (typeof raw?.label !== "string") continue;
    const label = normalizeText(raw.label);
    const date = normalizeTohoDateLabel(label, referenceIso);
    if (!date) continue;
    const key = `${date}|${raw.selected === true}|${raw.clickable === true}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ label, date, selected: raw.selected === true, clickable: raw.clickable === true });
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finitePosition(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function reviewedTohoScreenEdge(value: unknown): CinemaSeatMap<"toho">["screenEdge"] {
  if (!value || typeof value !== "object") return undefined;
  const marker = value as TohoScreenMarkerSnapshot;
  if (rawString(marker.id) !== "screen-defimg") return undefined;
  if (!rawString(marker.className).split(/\s+/).includes("screen-map")) return undefined;
  if (rawString(marker.backgroundPosition) !== "0% 0%") return undefined;
  if (!finitePosition(marker.rootTop) || !finitePosition(marker.seatMinTop) || marker.seatMinTop <= marker.rootTop) return undefined;
  const imageUrl = rawString(marker.imageUrl);
  if (!imageUrl) return undefined;
  try {
    const url = assertOfficialUrl(imageUrl, "toho");
    if (!url.pathname.endsWith("/screen.gif") || url.search || url.hash) return undefined;
  } catch {
    return undefined;
  }
  return "top";
}

export function normalizeTohoSeatSnapshot(
  snapshot: TohoSeatSnapshot,
  sourceUrl: string,
  theater: TohoTheater,
  showtime: TohoShowtime,
  observedAt = new Date().toISOString(),
  options: { allowSelected?: boolean } = {}
): CinemaSeatMap<"toho"> {
  let url: URL;
  try { url = assertOfficialUrl(sourceUrl, "toho"); } catch {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat map left the reviewed official provider boundary.");
  }
  const pathMatch = url.pathname.match(TOHO_SEAT_PATH);
  if (!pathMatch || pathMatch[1] !== theater.id || url.search || url.hash) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat-map route no longer matches the resolved theater context.");
  }
  if (!rawString(snapshot.title).includes("座席指定")) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat-map title is missing from the rendered public surface.");
  }
  if (rawString(snapshot.selectedSummary) && options.allowSelected !== true) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO read-only seat-map entry unexpectedly contains a selected seat state.");
  }
  if (!Array.isArray(snapshot.seats) || snapshot.seats.length < 20 || snapshot.seats.length > 1000) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat-map identity list is missing or implausible.", { count: Array.isArray(snapshot.seats) ? snapshot.seats.length : 0 });
  }
  const gridX = Array.isArray(snapshot.gridX) ? snapshot.gridX.filter(finitePosition).sort((a, b) => a - b) : [];
  const uniqueGridX = [...new Set(gridX)];
  if (uniqueGridX.length < 2) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO rendered seat layout no longer exposes usable horizontal slots.");
  }
  const rawSeats = snapshot.seats as TohoSeatSnapshotRow[];
  const yValues = [...new Set(rawSeats.map((seat) => seat.y).filter(finitePosition))].sort((a, b) => a - b);
  const ids = new Set<string>();
  const positions = new Set<string>();
  const seats: CinemaSeat[] = [];
  for (const raw of rawSeats) {
    const id = rawString(raw.id);
    const row = rawString(raw.row);
    const number = rawString(raw.number);
    if (!id || id !== `${row}-${number}` || !/^[A-Z]+-\d+$/.test(id) || ids.has(id) || !finitePosition(raw.x) || !finitePosition(raw.y)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat identity or rendered position became ambiguous.", { seatId: id || undefined });
    }
    ids.add(id);
    const columnIndex = uniqueGridX.indexOf(raw.x);
    const rowIndex = yValues.indexOf(raw.y);
    if (columnIndex < 0 || rowIndex < 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat position no longer maps to the rendered layout grid.", { seatId: id });
    }
    const position = `${rowIndex}:${columnIndex}`;
    if (positions.has(position)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO rendered seat positions are not unique.", { seatId: id, position });
    }
    positions.add(position);
    const src = rawString(raw.src);
    const alt = rawString(raw.alt);
    const onclick = rawString(raw.onclick);
    const clickMatch = onclick.match(/^JavaScript:seatSelect\('([A-Z]+)','(\d+)',\s*'\d+'\);$/);
    const clickMatchesIdentity = Boolean(clickMatch && clickMatch[1] === row && clickMatch[2] === number);
    let state: CinemaSeat["state"] = "unknown";
    if (src === "seat_3.gif" && alt === `${id} 選択中`) {
      state = "selected";
    } else if (clickMatchesIdentity && (src === "seat_1.gif" || src === "seat_4.gif")) {
      state = "available";
    } else if (!onclick && (src === "seat_0.gif" || src === "seat_2.gif")) {
      state = "unavailable";
    }
    seats.push({
      id,
      row,
      number,
      state,
      ...(state === "unavailable" ? { unavailableReason: "unknown" as const } : {}),
      attributes: src === "seat_4.gif" ? ["wheelchair"] : [],
      rowIndex,
      columnIndex,
      x: columnIndex,
      y: rowIndex
    });
  }
  const seatsBySemanticRow = new Map<string, CinemaSeat[]>();
  for (const seat of seats) {
    const key = seat.row ?? "";
    const rowSeats = seatsBySemanticRow.get(key) ?? [];
    rowSeats.push(seat);
    seatsBySemanticRow.set(key, rowSeats);
  }
  for (const rowSeats of seatsBySemanticRow.values()) {
    rowSeats.sort((a, b) => (a.columnIndex ?? 0) - (b.columnIndex ?? 0));
    for (let index = 1; index < rowSeats.length; index += 1) {
      const left = rowSeats[index - 1]!;
      const right = rowSeats[index]!;
      if (left.columnIndex === undefined || right.columnIndex === undefined) continue;
      if (right.columnIndex > left.columnIndex + 1) {
        left.rightBoundary = "gap";
        right.leftBoundary = "gap";
      }
    }
  }
  const selectedSeats = seats.filter((seat) => seat.state === "selected").map((seat) => seat.id);
  if (selectedSeats.length > 0 && options.allowSelected !== true) {
    throw new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "TOHO read-only seat-map entry unexpectedly contains a selected seat state.",
      { selectedSeats }
    );
  }
  const screenEdge = reviewedTohoScreenEdge(snapshot.screenMarker);
  const standardCapacity = typeof snapshot.standardCapacity === "number" && Number.isInteger(snapshot.standardCapacity) ? snapshot.standardCapacity : undefined;
  const wheelchairCapacity = typeof snapshot.wheelchairCapacity === "number" && Number.isInteger(snapshot.wheelchairCapacity) ? snapshot.wheelchairCapacity : undefined;
  if (standardCapacity !== undefined && wheelchairCapacity !== undefined) {
    if (standardCapacity + wheelchairCapacity !== seats.length) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO rendered seat count no longer matches the visible capacity summary.", {
        expected: standardCapacity + wheelchairCapacity,
        observed: seats.length
      });
    }
    const wheelchairSeats = seats.filter((seat) => seat.attributes.includes("wheelchair")).length;
    if (wheelchairSeats !== wheelchairCapacity) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO wheelchair-seat identities no longer match the visible capacity summary.", {
        expected: wheelchairCapacity,
        observed: wheelchairSeats
      });
    }
  }
  return {
    provider: "toho",
    theaterId: theater.id,
    theater: theater.name,
    ...(showtime.screen ? { screen: showtime.screen } : {}),
    showtimeIdentity: ["toho", theater.id, showtime.date, showtime.movie, showtime.startTime, showtime.endTime ?? "", showtime.screen ?? ""].join("|"),
    seats,
    ...(screenEdge ? { screenEdge } : {}),
    observedAt,
    sourceUrl: url.href
  };
}

export class TohoReadAdapter implements CinemaReadAdapter<"toho", TohoTheater, TohoShowtime>, CinemaSeatReadAdapter<"toho", TohoTheater, TohoShowtime> {
  constructor(private readonly runtime: CinemaBrowserRuntime) {}

  async listTheaters(query?: string): Promise<TheaterListResult<"toho", TohoTheater>> {
    const status = await this.runtime.status();
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!currentUrl.startsWith(TOHO_THEATER_LIST_URL)) {
      await this.runtime.navigateReviewed(TOHO_THEATER_LIST_URL, "toho");
    }

    let semantic = await this.runtime.evaluateSemanticState<TheaterSnapshot>("toho", THEATER_LIST_EXPRESSION);
    if (!Array.isArray(semantic.value.rows) || semantic.value.rows.length < MIN_THEATER_SCHEDULE_LINKS) {
      let regionCount = 0;
      let visibleScheduleLinks = 0;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const expansion = await this.runtime.evaluateSemanticState<TheaterRegionExpansionState>(
          "toho",
          EXPAND_THEATER_REGIONS_EXPRESSION
        );
        regionCount = countValue(expansion.value.regionCount);
        visibleScheduleLinks = countValue(expansion.value.visibleScheduleLinks);
        if (visibleScheduleLinks >= MIN_THEATER_SCHEDULE_LINKS) break;
        await sleep(180);
      }
      if (visibleScheduleLinks < MIN_THEATER_SCHEDULE_LINKS) {
        throw new BrowserRuntimeError(
          "UI_STATE_CHANGED",
          "TOHO regional theater controls did not expose enough reviewed public schedule links within the bounded wait.",
          { regionCount, visibleScheduleLinks }
        );
      }
      semantic = await this.runtime.evaluateSemanticState<TheaterSnapshot>("toho", THEATER_LIST_EXPRESSION);
    }

    let theaters = normalizeTohoTheaterSnapshot(semantic.value, semantic.url);
    if (query?.trim()) {
      const needle = normalizeTheaterQuery(query);
      theaters = theaters.filter((theater) =>
        normalizeTheaterQuery(theater.name).includes(needle) ||
        theater.aliases.some((alias) => normalizeTheaterQuery(alias).includes(needle))
      );
    }
    return { provider: "toho", sourceUrl: semantic.url, theaters };
  }

  async getShowtimes(input: ShowtimeQuery): Promise<ShowtimeResult<"toho", TohoTheater, TohoShowtime>> {
    const theater = await this.resolveTheater(input.theater);
    await this.runtime.navigateReviewed(theater.url, "toho");

    let semantic = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("toho", SCHEDULE_EXPRESSION);
    let dates = normalizeDateCandidates(semantic.value);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const theaterNames = stringArray(semantic.value.theaterNames, 4).filter((name) => /^TOHOシネマズ\s+/.test(name));
      if (semantic.value.scheduleHeadingCount === 1 && dates.length > 0 && theaterNames.length > 0) break;
      await sleep(180);
      semantic = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("toho", SCHEDULE_EXPRESSION);
      dates = normalizeDateCandidates(semantic.value);
    }
    assertScheduleIdentity(semantic.value, theater, semantic.url);
    if (dates.length === 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO date controls could not be read from the rendered public schedule UI.");
    }

    const requestedDate = input.date;
    let switchedRequestedDate = false;
    if (requestedDate) {
      const matches = dates.filter((candidate) => candidate.date === requestedDate);
      if (matches.length === 0) {
        return {
          provider: "toho",
          theater,
          date: requestedDate,
          dateAvailable: false,
          availableDates: [...new Set(dates.map((candidate) => candidate.date))].sort(),
          sourceUrl: semantic.url,
          showtimes: []
        };
      }
      const selectedDateSet = new Set(dates.filter((candidate) => candidate.selected).map((candidate) => candidate.date));
      if (selectedDateSet.size > 1) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO marks multiple dates as selected.", { selectedDates: [...selectedDateSet] });
      }
      if (!selectedDateSet.has(requestedDate)) {
        const clickableLabels = [...new Set(matches.filter((candidate) => candidate.clickable).map((candidate) => candidate.label))];
        if (clickableLabels.length !== 1) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO requested date is not represented by one unique visible date control.", { date: requestedDate, candidates: clickableLabels });
        }
        await this.clickDateControl(clickableLabels[0]!);
        let selected = false;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          semantic = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("toho", SCHEDULE_EXPRESSION);
          dates = normalizeDateCandidates(semantic.value);
          const selectedDates = [...new Set(dates.filter((candidate) => candidate.selected).map((candidate) => candidate.date))];
          if (selectedDates.length > 1) {
            throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO date selection became ambiguous after switching dates.", { selectedDates });
          }
          if (selectedDates[0] === requestedDate) {
            selected = true;
            break;
          }
          await sleep(180);
        }
        if (!selected) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO did not expose the requested date as the selected UI state after clicking it.", { date: requestedDate });
        }
        switchedRequestedDate = true;
      }
    }

    const selectedDates = [...new Set(dates.filter((candidate) => candidate.selected).map((candidate) => candidate.date))];
    const date = requestedDate ?? selectedDates[0];
    if (!date || selectedDates.length !== 1 || selectedDates[0] !== date) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO selected date is missing or ambiguous.", { selectedDates, requestedDate });
    }

    if (switchedRequestedDate && allShowtimesLookLikeSalePlaceholder(semantic.value)) {
      for (let attempt = 0; attempt < TOHO_SALE_STATE_SETTLE_ATTEMPTS; attempt += 1) {
        await sleep(TOHO_SALE_STATE_SETTLE_POLL_MS);
        const next = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("toho", SCHEDULE_EXPRESSION);
        assertScheduleIdentity(next.value, theater, next.url);
        const nextDates = normalizeDateCandidates(next.value);
        const nextSelectedDates = [...new Set(nextDates.filter((candidate) => candidate.selected).map((candidate) => candidate.date))];
        if (nextSelectedDates.length !== 1 || nextSelectedDates[0] !== date) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO selected date changed while waiting for the rendered sale state to settle.", {
            expectedDate: date,
            selectedDates: nextSelectedDates
          });
        }
        semantic = next;
        dates = nextDates;
        if (!allShowtimesLookLikeSalePlaceholder(semantic.value)) break;
      }
    }

    let showtimes = normalizeScheduleRows(semantic.value, theater, date, semantic.url);
    if (input.movie?.trim()) {
      const needle = normalizeText(input.movie).toLocaleLowerCase("ja-JP");
      showtimes = showtimes.filter((showtime) => showtime.movie.toLocaleLowerCase("ja-JP").includes(needle));
    }
    return {
      provider: "toho",
      theater,
      date,
      dateAvailable: true,
      availableDates: [...new Set(dates.map((candidate) => candidate.date))].sort(),
      sourceUrl: semantic.url,
      showtimes
    };
  }

  async getSeatAvailability(input: SeatAvailabilityQuery): Promise<SeatAvailabilityResult<"toho", TohoTheater, TohoShowtime>> {
    if (!/^\d{2}:\d{2}$/.test(input.startTime)) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "TOHO seat availability requires an exact 24-hour showtime startTime.");
    }
    const schedule = await this.getShowtimes({ theater: input.theater, date: input.date, movie: input.movie });
    if (!schedule.dateAvailable) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "TOHO requested seat-availability date is not exposed by the current public schedule.", { date: input.date });
    }
    let matches = schedule.showtimes.filter((showtime) => showtime.startTime === input.startTime);
    if (input.screen?.trim()) matches = matches.filter((showtime) => showtime.screen === input.screen!.trim());
    if (matches.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "TOHO showtime did not resolve to one unique rendered schedule row for seat availability.", {
        movie: input.movie,
        startTime: input.startTime,
        screen: input.screen,
        candidates: matches.slice(0, 8).map((showtime) => ({ movie: showtime.movie, startTime: showtime.startTime, screen: showtime.screen }))
      });
    }
    const showtime = matches[0]!;
    if (!showtime.screen) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat availability requires an observed screen identity from the rendered schedule row.");
    }
    if (showtime.availability === "sold_out" || showtime.availability === "unavailable") {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "TOHO showtime is not currently represented as a sellable seat-map entry.", { availability: showtime.availability });
    }

    const entry = await this.runtime.evaluateSemanticState<SeatEntrySnapshot>("toho", seatEntryExpression(showtime));
    const labels = stringArray(entry.value.labels, 4);
    if (entry.value.matched !== 1 || labels.length !== 1) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO sellable showtime is no longer represented by one reviewed public seat-map entry control.", {
        matchedRows: entry.value.matched,
        controls: labels
      });
    }
    await this.runtime.clickReviewedControl(labels[0]!, "toho");

    let status = await this.runtime.status();
    let currentUrl = typeof status.url === "string" ? status.url : "";
    let current = assertOfficialUrl(currentUrl, "toho");
    let seatMatch = current.pathname.match(TOHO_SEAT_PATH);
    const promotionMatch = current.pathname.match(TOHO_PROMOTION_PATH);
    if (!seatMatch) {
      if (!promotionMatch || promotionMatch[1] !== schedule.theater.id || current.search || current.hash) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO showtime entry did not reach the reviewed seat or non-member intermediate surface.");
      }
      let promotionReady = false;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        status = await this.runtime.status();
        currentUrl = typeof status.url === "string" ? status.url : "";
        current = assertOfficialUrl(currentUrl, "toho");
        const currentPromotion = current.pathname.match(TOHO_PROMOTION_PATH);
        if (!currentPromotion || currentPromotion[1] !== schedule.theater.id || current.search || current.hash) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO non-member intermediate surface left the reviewed theater context while settling.");
        }
        const promotion = await this.runtime.evaluateSemanticState<PromotionSnapshot>("toho", PROMOTION_EXPRESSION);
        if (
          rawString(promotion.value.title).includes("TOHOシネマズ") &&
          promotion.value.exactNonMemberControls === 1 &&
          promotion.value.sensitiveFields === 0
        ) {
          promotionReady = true;
          break;
        }
        await sleep(180);
      }
      if (!promotionReady) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO non-member intermediate surface did not expose the exact reviewed continuation within the bounded wait.");
      }
      await this.runtime.clickReviewedIntermediateControl("ログインせずに購入する", "toho");
      for (let attempt = 0; attempt < 16; attempt += 1) {
        status = await this.runtime.status();
        currentUrl = typeof status.url === "string" ? status.url : "";
        current = assertOfficialUrl(currentUrl, "toho");
        seatMatch = current.pathname.match(TOHO_SEAT_PATH);
        if (seatMatch) break;
        if (!current.pathname.match(TOHO_PROMOTION_PATH)) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO non-member continuation left the reviewed seat-map flow.");
        }
        await sleep(180);
      }
    }
    if (!seatMatch || seatMatch[1] !== schedule.theater.id || current.search || current.hash) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat-map route did not settle on the resolved theater context.");
    }
    let semantic = await this.runtime.evaluateSemanticState<TohoSeatSnapshot>("toho", TOHO_SEAT_MAP_EXPRESSION);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const seatCount = Array.isArray(semantic.value.seats) ? semantic.value.seats.length : 0;
      if (rawString(semantic.value.title).includes("座席指定") && seatCount >= 20 && seatCount <= 1000) break;
      await sleep(180);
      semantic = await this.runtime.evaluateSemanticState<TohoSeatSnapshot>("toho", TOHO_SEAT_MAP_EXPRESSION);
    }
    const seatMap = normalizeTohoSeatSnapshot(semantic.value, semantic.url, schedule.theater, showtime);
    return { provider: "toho", theater: schedule.theater, showtime, seatMap };
  }

  private async clickDateControl(label: string): Promise<void> {
    const targetLabel = JSON.stringify(label);
    const semantic = await this.runtime.evaluateSemanticState<DateClickState>("toho", `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const rendered = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const target = ${targetLabel};
      const matches = Array.from(document.querySelectorAll('.schedule-tab-wrapper .schedule-tab-item'))
        .filter(rendered)
        .filter((el) => normalize(el.querySelector('.schedule-tab-dates')?.textContent) === target);
      if (matches.length !== 1) return { matched: matches.length, clicked: false };
      const item = matches[0];
      if (!item.classList.contains('is-selected')) item.click();
      return { matched: 1, clicked: true };
    })()`);
    if (semantic.value.matched !== 1 || semantic.value.clicked !== true) {
      throw new BrowserRuntimeError(
        "UI_STATE_CHANGED",
        "TOHO requested date is not represented by one unique reviewed public schedule tab.",
        { label, matched: semantic.value.matched }
      );
    }
  }

  private async resolveTheater(query: string): Promise<TohoTheater> {
    const result = await this.listTheaters(query);
    const needle = normalizeTheaterQuery(query);
    const exact = result.theaters.filter((theater) =>
      normalizeTheaterQuery(theater.name) === needle ||
      theater.aliases.some((alias) => normalizeTheaterQuery(alias) === needle)
    );
    const candidates = exact.length > 0 ? exact : result.theaters;
    if (candidates.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "TOHO theater name did not resolve to one unique reviewed public schedule group.", {
        query,
        candidates: candidates.slice(0, 12).map((theater) => theater.name)
      });
    }
    return candidates[0]!;
  }
}