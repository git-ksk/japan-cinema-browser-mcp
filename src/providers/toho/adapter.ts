import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";

const TOHO_THEATER_LIST_URL = "https://www.tohotheater.jp/theater/find.html";
const TOHO_SCHEDULE_PATH = /^\/net\/schedule\/(\d{3})\/TNPI2000J01\.do$/;

export interface TohoTheater {
  provider: "toho";
  id: string;
  name: string;
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

  const datePattern = /(?:^|\\s)(?:20\\d{2}[.\\/年-])?(\\d{1,2})[.\\/月-](\\d{1,2})(?:日)?(?:\\s|\\(|（|$)/;
  const selectedSignal = (el) => {
    const own = [el.getAttribute('aria-current'), el.getAttribute('aria-selected'), el.className].map(normalize).join(' ');
    const parent = el.parentElement
      ? [el.parentElement.getAttribute('aria-current'), el.parentElement.getAttribute('aria-selected'), el.parentElement.className].map(normalize).join(' ')
      : '';
    return /(?:^|[\\s_-])(?:active|current|selected|on)(?:$|[\\s_-])/i.test(own + ' ' + parent) ||
      /^(?:true|date|page)$/i.test(normalize(el.getAttribute('aria-current'))) ||
      /^true$/i.test(normalize(el.getAttribute('aria-selected')));
  };
  const clickable = (el) => el.matches('a,button,[role="button"],[role="tab"],[role="link"]');
  const dateNodes = Array.from(document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="link"],li,span,time'))
    .filter(visible)
    .map((el) => ({ el, label: normalize(el.getAttribute('aria-label') || el.textContent) }))
    .filter(({ label }) => label.length > 0 && label.length <= 48 && datePattern.test(label));
  const dates = [];
  const dateSeen = new Set();
  for (const item of dateNodes) {
    const key = item.label + '|' + selectedSignal(item.el) + '|' + clickable(item.el);
    if (dateSeen.has(key)) continue;
    dateSeen.add(key);
    dates.push({ label: item.label, selected: selectedSignal(item.el), clickable: clickable(item.el) });
    if (dates.length >= 40) break;
  }

  const titleRejected = /^(?:上映スケジュール|この劇場の公開予定作品|販売期間外|購入|詳細|字幕|吹替|IMAX|MX4D|TCX|SCREEN\\s*X|Dolby|ATMOS|3D|2D|轟音|PREMIUM\\s+THEATER)$/i;
  const titleCandidate = (text) => text.length >= 2 && text.length <= 180 && !titleRejected.test(text) && !/^(?:\\d{1,2}[.:：]\\d{2})/.test(text);
  const candidateSelectors = 'h3,h4,h5,h6,[class*="title" i],[class*="movie" i],[class*="film" i]';
  const titleCandidatesFor = (control) => {
    const result = [];
    const seen = new Set();
    let parent = control.parentElement;
    for (let depth = 0; parent && depth < 7; depth += 1, parent = parent.parentElement) {
      const nodes = Array.from(parent.querySelectorAll(candidateSelectors))
        .filter((el) => visible(el) && inScheduleRange(el) && before(el, control))
        .map((el) => normalize(el.textContent))
        .filter(titleCandidate);
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const text = nodes[i];
        if (seen.has(text)) continue;
        seen.add(text);
        result.push(text);
        if (result.length >= 5) return result;
      }
    }
    return result;
  };
  const contextFor = (control) => {
    let parent = control.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
      const text = normalize(parent.innerText || parent.textContent);
      if (text.length >= 8 && text.length <= 650) return text;
    }
    return normalize(control.textContent).slice(0, 240);
  };

  const timePattern = /(?:^|\\D)((?:[01]?\\d|2[0-3])[:：][0-5]\\d)(?!\\d)/;
  const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]'))
    .filter((el) => visible(el) && inScheduleRange(el))
    .map((el) => ({ el, label: normalize(el.getAttribute('aria-label') || el.textContent) }))
    .filter(({ label }) => label.length > 0 && label.length <= 160 && timePattern.test(label));
  const showtimes = [];
  const showtimeSeen = new Set();
  for (const item of controls) {
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

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map(normalizeText).filter(Boolean).slice(0, limit);
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

export function normalizeTohoDateLabel(label: string, referenceIso = tokyoTodayIso()): string | undefined {
  const normalized = normalizeText(label).replace(/：/g, ":");
  const full = normalized.match(/(20\d{2})[.\/年-](\d{1,2})[.\/月-](\d{1,2})(?:日)?/);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const short = normalized.match(/(?:^|\s)(\d{1,2})[.\/月-](\d{1,2})(?:日)?(?:\s|\(|（|$)/);
  if (!short) return undefined;
  const month = Number(short[1]);
  const day = Number(short[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const reference = new Date(`${referenceIso}T00:00:00Z`);
  if (Number.isNaN(reference.getTime())) return undefined;
  const refYear = reference.getUTCFullYear();
  const candidates = [refYear - 1, refYear, refYear + 1]
    .map((year) => {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
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
  const byId = new Map<string, TohoTheater>();
  for (const raw of snapshot.rows.slice(0, 160) as TheaterSnapshotRow[]) {
    if (typeof raw?.id !== "string" || typeof raw.name !== "string" || typeof raw.url !== "string") continue;
    let url: URL;
    try { url = new URL(raw.url); } catch { continue; }
    const pathMatch = url.pathname.match(TOHO_SCHEDULE_PATH);
    if (!pathMatch || pathMatch[1] !== raw.id || url.protocol !== "https:" || !url.hostname.endsWith("tohotheater.jp")) continue;
    const name = normalizeText(raw.name);
    if (!/^TOHOシネマズ\s+/.test(name)) continue;
    const candidate: TohoTheater = { provider: "toho", id: raw.id, name, url: url.href, sourceUrl };
    const existing = byId.get(raw.id);
    if (existing && (existing.name !== candidate.name || existing.url !== candidate.url)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO theater list contains conflicting entries for the same theater id.", { theaterId: raw.id });
    }
    byId.set(raw.id, candidate);
  }
  const theaters = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (theaters.length < 20) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO theater list extraction returned too few theaters; the public UI may have changed.", { count: theaters.length });
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
  return [...label.replace(/：/g, ":").matchAll(/(?:^|\D)((?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)/g)]
    .map((match) => match[1]?.padStart(5, "0"))
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);
}

function normalizeScheduleRows(snapshot: ScheduleSnapshot, theater: TohoTheater, date: string, sourceUrl: string): TohoShowtime[] {
  if (snapshot.scheduleHeadingCount !== 1) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule heading is missing or ambiguous.", { count: snapshot.scheduleHeadingCount });
  }
  const theaterNames = stringArray(snapshot.theaterNames, 4).filter((name) => /^TOHOシネマズ\s+/.test(name));
  if (theaterNames.length !== 1 || normalizeTheaterQuery(theaterNames[0]!) !== normalizeTheaterQuery(theater.name)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule page theater identity does not match the requested theater.", { expected: theater.name, observed: theaterNames });
  }
  if (!Array.isArray(snapshot.showtimes)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule rows are unavailable from the rendered public UI.");
  }
  if (snapshot.showtimes.length === 0 && snapshot.emptySchedule !== true) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO schedule page contains no recognizable showtime controls and no explicit empty-schedule state.");
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
    const screenMatch = semanticText.match(/(?:スクリーン|SCREEN)\s*([A-Z0-9-]+)/i);
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
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Some TOHO showtime controls could not be associated with one movie title; refusing a partial ambiguous result.", { unresolved: unresolved.slice(0, 8) });
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
    const sourceUrl = currentUrl.startsWith(TOHO_THEATER_LIST_URL)
      ? currentUrl
      : await this.runtime.navigate(TOHO_THEATER_LIST_URL, "toho");
    const semantic = await this.runtime.evaluateSemanticState<TheaterSnapshot>("toho", THEATER_LIST_EXPRESSION);
    let theaters = normalizeTohoTheaterSnapshot(semantic.value, semantic.url);
    if (query?.trim()) {
      const needle = normalizeTheaterQuery(query);
      theaters = theaters.filter((theater) => normalizeTheaterQuery(theater.name).includes(needle));
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
      const selectedMatches = matches.filter((candidate) => candidate.selected);
      if (selectedMatches.length > 1) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO marks multiple controls for the requested date as selected.", { date: requestedDate });
      }
      if (selectedMatches.length === 0) {
        const clickableLabels = [...new Set(matches.filter((candidate) => candidate.clickable).map((candidate) => candidate.label))];
        if (clickableLabels.length !== 1) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO requested date is not represented by one unique visible date control.", { date: requestedDate, candidates: clickableLabels });
        }
        await this.runtime.clickControl(clickableLabels[0]!);
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

  private async resolveTheater(query: string): Promise<TohoTheater> {
    const result = await this.listTheaters(query);
    const needle = normalizeTheaterQuery(query);
    const exact = result.theaters.filter((theater) => normalizeTheaterQuery(theater.name) === needle);
    const candidates = exact.length > 0 ? exact : result.theaters;
    if (candidates.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "TOHO theater name did not resolve to one unique reviewed theater link.", {
        query,
        candidates: candidates.slice(0, 12).map((theater) => theater.name)
      });
    }
    return candidates[0]!;
  }
}
