import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";
import { assertOfficialUrl } from "../../providers.js";

const TOHO_THEATER_LIST_URL = "https://www.tohotheater.jp/theater/find.html";
const TOHO_SCHEDULE_PATH = /^\/net\/schedule\/(\d{3})\/TNPI2000J01\.do$/;
const MIN_THEATER_SCHEDULE_LINKS = 20;

export interface TohoTheater {
  provider: "toho";
  id: string;
  name: string;
  aliases: string[];
  url: string;
  sourceUrl: string;
}

export interface TohoShowtime {
  provider: "toho";
  theaterId: string;
  theater: string;
  date: string;
  movie: string;
  startTime: string;
  endTime?: string;
  formats: string[];
  language?: "subtitled" | "dubbed";
  screen?: string;
  availability: "unknown" | "limited" | "sold_out" | "unavailable";
  sourceUrl: string;
}

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

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

function normalizedFormats(text: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/IMAX\s*(?:レーザー|LASER)/i, "IMAX LASER"],
    [/\bIMAX\b/i, "IMAX"],
    [/Dolby\s*Cinema|ドルビーシネマ/i, "DOLBY CINEMA"],
    [/MX4D/i, "MX4D"],
    [/SCREEN\s*X/i, "SCREEN X"],
    [/DTS\s*:?\s*X/i, "DTS:X"],
    [/ATMOS|アトモス/i, "DOLBY ATMOS"],
    [/\bTCX\b/i, "TCX"],
    [/PREMIUM\s+THEATER|プレミアムシアター/i, "PREMIUM THEATER"],
    [/轟音/, "GO-ON"],
    [/(?:^|[\s【\[(])3D(?:[\s】\])]|$)/i, "3D"]
  ];
  const values: string[] = [];
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
    const screenMatch = semanticText.match(/(?:スクリーン|SCREEN)\s*(?:No\.?\s*)?(\d{1,2}[A-Z]?)/i);
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

export class TohoReadAdapter {
  constructor(private readonly runtime: CinemaBrowserRuntime) {}

  async listTheaters(query?: string): Promise<{ provider: "toho"; sourceUrl: string; theaters: TohoTheater[] }> {
    const status = await this.runtime.status();
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!currentUrl.startsWith(TOHO_THEATER_LIST_URL)) {
      await this.runtime.navigate(TOHO_THEATER_LIST_URL, "toho");
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

  async getShowtimes(input: { theater: string; date?: string; movie?: string }): Promise<{
    provider: "toho";
    theater: TohoTheater;
    date: string;
    dateAvailable: boolean;
    availableDates: string[];
    sourceUrl: string;
    showtimes: TohoShowtime[];
  }> {
    const theater = await this.resolveTheater(input.theater);
    await this.runtime.navigate(theater.url, "toho");

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
      }
    }

    const selectedDates = [...new Set(dates.filter((candidate) => candidate.selected).map((candidate) => candidate.date))];
    const date = requestedDate ?? selectedDates[0];
    if (!date || selectedDates.length !== 1 || selectedDates[0] !== date) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO selected date is missing or ambiguous.", { selectedDates, requestedDate });
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