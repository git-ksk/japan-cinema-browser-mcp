import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";
import { assertOfficialUrl } from "../../providers.js";

const AEON_THEATER_LIST_URL = "https://www.aeoncinema.com/theater/";
const AEON_SCHEDULE_PATH = /^\/theaters\/([a-z0-9_-]+)\/?$/;
const MIN_REVIEWED_THEATER_COUNT = 50;

const PREFECTURES = [
  "北海道", "青森", "秋田", "岩手", "宮城", "山形", "福島", "群馬", "茨城", "埼玉", "東京", "千葉", "神奈川",
  "新潟", "富山", "石川", "長野", "岐阜", "静岡", "愛知", "三重", "滋賀", "京都", "大阪", "兵庫", "和歌山",
  "岡山", "広島", "島根", "山口", "香川", "徳島", "愛媛", "福岡", "佐賀", "熊本"
] as const;

export interface AeonTheater {
  provider: "aeon";
  id: string;
  name: string;
  sourceUrl: string;
  scheduleUrl?: string;
}

export interface AeonTheaterCandidate extends AeonTheater {
  selectionLabel: string;
}

export interface AeonShowtime {
  provider: "aeon";
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
  label?: unknown;
  href?: unknown;
  route?: unknown;
}

interface TheaterSnapshot {
  headingCount?: unknown;
  rows?: unknown;
}

interface ScheduleSnapshotRow {
  movie?: unknown;
  label?: unknown;
  context?: unknown;
}

interface ScheduleSnapshot {
  title?: unknown;
  scheduleHeadingCount?: unknown;
  theaterNames?: unknown;
  dateLabels?: unknown;
  showtimes?: unknown;
  ambiguousTimeGroups?: unknown;
  emptySchedule?: unknown;
}

const THEATER_LIST_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
  };
  const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const prefectures = new Set(${JSON.stringify(PREFECTURES)});
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible);
  const headingCount = headings.filter((el) => normalize(el.textContent) === '劇場を探す').length;
  const boundary = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,p,span'))
    .filter(visible)
    .find((el) => /^STEP2上映日を選択/.test(normalize(el.textContent))) || null;
  const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]')).filter(visible);
  const dataKeys = ['data-url','data-href','data-theater-url','data-cinema-url','data-link'];
  const rows = [];
  for (const control of controls) {
    if (boundary && !before(control, boundary)) continue;
    const label = normalize(control.getAttribute('aria-label') || control.textContent);
    if (!label || label.length > 140) continue;
    let nearestHeading = null;
    for (const heading of headings) {
      if (before(heading, control)) nearestHeading = heading;
    }
    if (!nearestHeading || !prefectures.has(normalize(nearestHeading.textContent))) continue;
    const href = control.matches('a[href]') ? control.href || '' : '';
    let route = '';
    let node = control;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      if (route) break;
      for (const key of dataKeys) {
        const value = normalize(node.getAttribute?.(key));
        if (value) { route = value; break; }
      }
    }
    rows.push({ label, href, route });
    if (rows.length >= 160) break;
  }
  return { headingCount, rows };
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
  const scheduleHeadingCount = headings.filter((el) => /^上映スケジュール(?:\\s|$)/.test(normalize(el.textContent))).length;
  const theaterNames = headings
    .map((el) => normalize(el.textContent))
    .filter((text) => /^イオンシネマ(?:\\s|$)/.test(text) && text.length > 'イオンシネマ'.length)
    .slice(0, 4);

  const datePattern = /(?:本日|(?:\\d{1,2})\\/(?:\\d{1,2})[（(][^）)]{1,4}[）)])/;
  const dateLabels = Array.from(document.querySelectorAll('a,button,[role="button"],[role="tab"],li,span,time'))
    .filter(visible)
    .map((el) => normalize(el.getAttribute('aria-label') || el.textContent))
    .filter((text) => text.length > 0 && text.length <= 64 && datePattern.test(text))
    .slice(0, 48);

  const timeRange = /(?:^|\\D)((?:[01]?\\d|2\\d)[:：][0-5]\\d)\\s*[~〜～ー-]\\s*((?:[01]?\\d|2\\d)[:：][0-5]\\d)(?!\\d)/;
  const allTimeRanges = (text) => Array.from(text.matchAll(/((?:[01]?\\d|2\\d)[:：][0-5]\\d)\\s*[~〜～ー-]\\s*((?:[01]?\\d|2\\d)[:：][0-5]\\d)/g));
  const titleRejected = /^(?:上映スケジュール|劇場情報|作品から探す|上映時間から探す|販売開始日時について|すべてを読む|予約購入|Coming soon)$/i;
  const titleNodes = Array.from(document.querySelectorAll('a[href*="/movie/"],h2,h3,h4,h5,h6'))
    .filter(visible)
    .map((el) => ({ el, text: normalize(el.textContent), preferred: el.matches('a[href*="/movie/"]') }))
    .filter((item) => item.text.length >= 2 && item.text.length <= 180 && !titleRejected.test(item.text) && !/^イオンシネマ(?:\\s|$)/.test(item.text));

  const candidateElements = Array.from(document.querySelectorAll('a,button,div,p,span,li')).filter(visible);
  const timeItems = candidateElements
    .map((el) => ({ el, text: normalize(el.getAttribute('aria-label') || el.textContent) }))
    .filter((item) => item.text.length > 0 && item.text.length <= 260 && timeRange.test(item.text))
    .map((item) => ({ ...item, ranges: allTimeRanges(item.text) }))
    .filter((item) => !Array.from(item.el.children).some((child) => visible(child) && timeRange.test(normalize(child.textContent))));
  const ambiguousTimeGroups = timeItems.filter((item) => item.ranges.length !== 1).length;
  const timeNodes = timeItems.filter((item) => item.ranges.length === 1);

  const titleFor = (control) => {
    let parent = control.parentElement;
    for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
      const candidates = titleNodes.filter((item) => parent.contains(item.el) && before(item.el, control));
      const preferred = candidates.filter((item) => item.preferred);
      const pool = preferred.length > 0 ? preferred : candidates;
      if (pool.length > 0) return pool[pool.length - 1].text;
    }
    return '';
  };

  const contextFor = (control) => {
    let parent = control.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
      const text = normalize(parent.innerText || parent.textContent);
      if (text.length >= 8 && text.length <= 700) return text;
    }
    return normalize(control.textContent).slice(0, 260);
  };

  const showtimes = [];
  const seen = new Set();
  for (const item of timeNodes) {
    const match = item.ranges[0];
    if (!match?.[1] || !match[2]) continue;
    const movie = titleFor(item.el);
    const key = movie + '|' + match[1] + '|' + match[2];
    if (seen.has(key)) continue;
    seen.add(key);
    showtimes.push({ movie, label: match[1] + '~' + match[2], context: contextFor(item.el) });
    if (showtimes.length >= 180) break;
  }

  const bodyText = normalize((document.querySelector('main') || document.body)?.innerText || '').slice(0, 12000);
  return {
    title: document.title,
    scheduleHeadingCount,
    theaterNames,
    dateLabels,
    showtimes,
    ambiguousTimeGroups,
    emptySchedule: /(?:上映スケジュールはありません|上映予定はありません|上映回はありません)/.test(bodyText)
  };
})()`;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTheaterQuery(value: string): string {
  return normalizeText(value).replace(/^イオンシネマ\s*/i, "").toLocaleLowerCase("ja-JP");
}

function stripFacilitySuffix(label: string): string {
  return normalizeText(label).replace(
    /\s+(?=(?:4DX|Dolby\s+Atmos|IMAX(?:レーザー)?|MX4D|THX|ULTI(?:RA|LA)|GRAN\s+THEATER|D-BOX|VSound|VIVE\s+AUDIO|dts\s+surround\s+cinema|dtsX|Christie\s+RealLaser|MULTIPLEX)(?:\s|$)).*$/i,
    ""
  ).trim();
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

function scheduleRouteFromValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim(), AEON_THEATER_LIST_URL);
  } catch {
    return undefined;
  }
  try {
    assertOfficialUrl(url.href, "aeon");
  } catch {
    return undefined;
  }
  if (url.hostname !== "theater.aeoncinema.com" || !AEON_SCHEDULE_PATH.test(url.pathname)) return undefined;
  url.search = "";
  url.hash = "";
  return url.href;
}

function publicTheater(candidate: AeonTheaterCandidate): AeonTheater {
  const { selectionLabel: _selectionLabel, ...theater } = candidate;
  return theater;
}

export function normalizeAeonTheaterSnapshot(snapshot: TheaterSnapshot, sourceUrl: string): AeonTheaterCandidate[] {
  if (snapshot.headingCount !== 1 || !Array.isArray(snapshot.rows)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON theater list no longer exposes the reviewed public theater-selection structure.");
  }
  const byName = new Map<string, AeonTheaterCandidate>();
  for (const raw of snapshot.rows.slice(0, 160) as TheaterSnapshotRow[]) {
    if (typeof raw?.label !== "string") continue;
    const selectionLabel = normalizeText(raw.label);
    const baseName = stripFacilitySuffix(selectionLabel);
    if (!baseName || baseName.length > 60) continue;
    if (/^(?:全て|現在地から探す|変更|閉じる|今すぐ予約|北海道|東北|関東|北越|中部|近畿|中国・四国|九州)$/.test(baseName)) continue;
    const scheduleUrl = scheduleRouteFromValue(raw.href) ?? scheduleRouteFromValue(raw.route);
    const id = scheduleUrl ? new URL(scheduleUrl).pathname.match(AEON_SCHEDULE_PATH)?.[1] ?? baseName : baseName;
    const key = normalizeTheaterQuery(baseName);
    if (!key) continue;
    const existing = byName.get(key);
    if (existing && existing.selectionLabel !== selectionLabel) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON theater name resolves to multiple visible controls.", {
        theater: baseName,
        candidates: [existing.selectionLabel, selectionLabel]
      });
    }
    byName.set(key, {
      provider: "aeon",
      id,
      name: `イオンシネマ ${baseName}`,
      sourceUrl,
      ...(scheduleUrl ? { scheduleUrl } : {}),
      selectionLabel
    });
  }
  const theaters = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (theaters.length < MIN_REVIEWED_THEATER_COUNT) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON theater list extraction returned too few theaters; the public UI may have changed.", {
      count: theaters.length
    });
  }
  return theaters;
}

export function buildAeonScheduleUrl(scheduleUrl: string, date: string): string {
  if (!validIsoDate(date)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON requested date is not a valid calendar date.", { date });
  }
  let url: URL;
  try {
    url = assertOfficialUrl(scheduleUrl, "aeon");
  } catch (error) {
    throw new BrowserRuntimeError("URL_NOT_ALLOWED", error instanceof Error ? error.message : "AEON schedule URL is not allowed.");
  }
  if (url.hostname !== "theater.aeoncinema.com" || !AEON_SCHEDULE_PATH.test(url.pathname)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule URL is outside the reviewed public theater route.", { scheduleUrl });
  }
  url.search = "";
  url.hash = "";
  url.searchParams.set("date", date.replaceAll("-", ""));
  return url.href;
}

function normalizeFormats(text: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/IMAX\s*(?:レーザー|LASER)/i, "IMAX LASER"],
    [/\bIMAX\b/i, "IMAX"],
    [/\b4DX\b/i, "4DX"],
    [/\bMX4D\b/i, "MX4D"],
    [/Dolby\s*Atmos|ドルビーアトモス/i, "DOLBY ATMOS"],
    [/\bTHX\b/i, "THX"],
    [/ULTIRA/i, "ULTIRA"],
    [/ULTILA/i, "ULTILA"],
    [/D-BOX/i, "D-BOX"],
    [/VSound/i, "VSOUND"],
    [/VIVE\s*AUDIO/i, "VIVE AUDIO"],
    [/dts\s*X/i, "DTS:X"],
    [/(?:^|[\s【\[(])3D(?:[\s】\])]|$)/i, "3D"]
  ];
  const values: string[] = [];
  for (const [pattern, label] of checks) {
    if (pattern.test(text) && !values.includes(label)) values.push(label);
  }
  return values.includes("IMAX LASER") ? values.filter((value) => value !== "IMAX") : values;
}

function timeRange(label: string): [string, string] | undefined {
  const match = label.replace(/：/g, ":").match(/((?:[01]?\d|2\d):[0-5]\d)\s*[~〜～ー-]\s*((?:[01]?\d|2\d):[0-5]\d)/);
  if (!match?.[1] || !match[2]) return undefined;
  return [match[1].padStart(5, "0"), match[2].padStart(5, "0")];
}

function scheduleIdentityMatches(snapshot: ScheduleSnapshot, theater: AeonTheaterCandidate): boolean {
  const expected = normalizeTheaterQuery(theater.name);
  const title = typeof snapshot.title === "string" ? normalizeText(snapshot.title) : "";
  const titleMatch = title.match(/^上映スケジュール[｜|]\s*(.+?)[｜|]\s*イオンシネマ/);
  if (titleMatch?.[1] && normalizeTheaterQuery(titleMatch[1]) === expected) return true;
  const names = Array.isArray(snapshot.theaterNames)
    ? snapshot.theaterNames.filter((value): value is string => typeof value === "string").map(normalizeTheaterQuery)
    : [];
  return names.includes(expected);
}

export function normalizeAeonScheduleSnapshot(
  snapshot: ScheduleSnapshot,
  theater: AeonTheaterCandidate,
  date: string,
  sourceUrl: string
): AeonShowtime[] {
  if (snapshot.scheduleHeadingCount !== 1) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule heading is missing or ambiguous.", { count: snapshot.scheduleHeadingCount });
  }
  if (!scheduleIdentityMatches(snapshot, theater)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule page theater identity does not match the requested theater.", {
      expected: theater.name,
      title: snapshot.title,
      observed: snapshot.theaterNames
    });
  }
  if (typeof snapshot.ambiguousTimeGroups === "number" && snapshot.ambiguousTimeGroups > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON rendered time ranges could not be separated into unique showtime rows.", {
      ambiguousTimeGroups: snapshot.ambiguousTimeGroups
    });
  }
  if (!Array.isArray(snapshot.showtimes)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON showtime rows are unavailable from the rendered public UI.");
  }
  if (snapshot.showtimes.length === 0 && snapshot.emptySchedule !== true) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule has no recognizable showtime rows and no explicit empty state.");
  }

  const result: AeonShowtime[] = [];
  const unresolved: string[] = [];
  for (const raw of snapshot.showtimes.slice(0, 180) as ScheduleSnapshotRow[]) {
    if (typeof raw?.label !== "string") continue;
    const range = timeRange(raw.label);
    if (!range) continue;
    const movie = typeof raw.movie === "string" ? normalizeText(raw.movie) : "";
    if (!movie || /^(?:上映スケジュール|劇場情報|予約購入|すべてを読む)$/i.test(movie)) {
      unresolved.push(normalizeText(raw.label).slice(0, 120));
      continue;
    }
    const context = typeof raw.context === "string" ? normalizeText(raw.context).slice(0, 700) : "";
    const semanticText = `${movie} ${context}`;
    const screenMatch = semanticText.match(/(?:スクリーン|SCREEN)\s*([0-9]{1,2}|[A-WYZ])/i);
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
      provider: "aeon",
      theaterId: theater.id,
      theater: theater.name,
      date,
      movie,
      startTime: range[0],
      endTime: range[1],
      formats: normalizeFormats(semanticText),
      ...(language ? { language } : {}),
      ...(screenMatch?.[1] ? { screen: screenMatch[1] } : {}),
      availability,
      sourceUrl
    });
  }
  if (unresolved.length > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "Some AEON showtime rows could not be associated with one movie title; refusing a partial result.", {
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
    const url = assertOfficialUrl(value, "aeon");
    return url.hostname === "www.aeoncinema.com" && ["/theater", "/theater/", "/theater/index.html"].includes(url.pathname);
  } catch {
    return false;
  }
}

function scheduleUrlFromCurrent(value: string): string | undefined {
  try {
    const url = assertOfficialUrl(value, "aeon");
    if (url.hostname !== "theater.aeoncinema.com" || !AEON_SCHEDULE_PATH.test(url.pathname)) return undefined;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AeonReadAdapter {
  constructor(private readonly runtime: CinemaBrowserRuntime) {}

  async listTheaters(query?: string): Promise<{ provider: "aeon"; sourceUrl: string; theaters: AeonTheater[] }> {
    const candidates = await this.readTheaterCandidates(query);
    return {
      provider: "aeon",
      sourceUrl: candidates.sourceUrl,
      theaters: candidates.theaters.map(publicTheater)
    };
  }

  async getShowtimes(input: { theater: string; date?: string; movie?: string }): Promise<{
    provider: "aeon";
    theater: AeonTheater;
    date: string;
    dateAvailable: boolean;
    availableDates: string[];
    sourceUrl: string;
    showtimes: AeonShowtime[];
  }> {
    const theater = await this.resolveTheater(input.theater);
    const baseScheduleUrl = theater.scheduleUrl ?? await this.openScheduleThroughPublicUi(theater);
    const date = input.date ?? tokyoTodayIso();
    const targetUrl = buildAeonScheduleUrl(baseScheduleUrl, date);
    const sourceUrl = await this.runtime.navigate(targetUrl, "aeon");
    const current = new URL(sourceUrl);
    const expectedPath = new URL(baseScheduleUrl).pathname;
    if (
      current.hostname !== "theater.aeoncinema.com" ||
      current.pathname !== expectedPath ||
      current.searchParams.get("date") !== date.replaceAll("-", "")
    ) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON redirected away from the requested reviewed schedule route/date.", {
        expected: targetUrl,
        actual: sourceUrl
      });
    }
    const semantic = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("aeon", SCHEDULE_EXPRESSION);
    let showtimes = normalizeAeonScheduleSnapshot(semantic.value, theater, date, semantic.url);
    if (input.movie?.trim()) {
      const needle = normalizeText(input.movie).toLocaleLowerCase("ja-JP");
      showtimes = showtimes.filter((showtime) => showtime.movie.toLocaleLowerCase("ja-JP").includes(needle));
    }
    return {
      provider: "aeon",
      theater: publicTheater({ ...theater, scheduleUrl: baseScheduleUrl }),
      date,
      dateAvailable: showtimes.length > 0 || semantic.value.emptySchedule === true,
      availableDates: this.normalizeAvailableDates(semantic.value.dateLabels, date),
      sourceUrl: semantic.url,
      showtimes
    };
  }

  private async readTheaterCandidates(query?: string): Promise<{ sourceUrl: string; theaters: AeonTheaterCandidate[] }> {
    const status = await this.runtime.status();
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!isTheaterListUrl(currentUrl)) {
      await this.runtime.navigate(AEON_THEATER_LIST_URL, "aeon");
    }
    const semantic = await this.runtime.evaluateSemanticState<TheaterSnapshot>("aeon", THEATER_LIST_EXPRESSION);
    let theaters = normalizeAeonTheaterSnapshot(semantic.value, semantic.url);
    if (query?.trim()) {
      const needle = normalizeTheaterQuery(query);
      theaters = theaters.filter((theater) => normalizeTheaterQuery(theater.name).includes(needle));
    }
    return { sourceUrl: semantic.url, theaters };
  }

  private async resolveTheater(query: string): Promise<AeonTheaterCandidate> {
    const result = await this.readTheaterCandidates(query);
    const needle = normalizeTheaterQuery(query);
    const exact = result.theaters.filter((theater) => normalizeTheaterQuery(theater.name) === needle);
    const candidates = exact.length > 0 ? exact : result.theaters;
    if (candidates.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "AEON theater name did not resolve to one unique public theater control.", {
        query,
        candidates: candidates.slice(0, 12).map((theater) => theater.name)
      });
    }
    return candidates[0]!;
  }

  private async openScheduleThroughPublicUi(theater: AeonTheaterCandidate): Promise<string> {
    await this.runtime.clickControl(theater.selectionLabel);
    const direct = await this.waitForScheduleUrl(6, 180);
    if (direct) return direct;

    await this.runtime.clickControl("上映スケジュールを確認する");
    const scheduleUrl = await this.waitForScheduleUrl(24, 180);
    if (!scheduleUrl) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON public theater selection did not resolve to a reviewed schedule page.", {
        theater: theater.name
      });
    }
    return scheduleUrl;
  }

  private async waitForScheduleUrl(attempts: number, delayMs: number): Promise<string | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.runtime.status();
      const url = typeof status.url === "string" ? scheduleUrlFromCurrent(status.url) : undefined;
      if (url) return url;
      await sleep(delayMs);
    }
    return undefined;
  }

  private normalizeAvailableDates(value: unknown, referenceDate: string): string[] {
    if (!Array.isArray(value)) return [referenceDate];
    const reference = new Date(`${referenceDate}T00:00:00Z`);
    const refYear = reference.getUTCFullYear();
    const result = new Set<string>([referenceDate]);
    for (const raw of value.slice(0, 48)) {
      if (typeof raw !== "string") continue;
      const text = normalizeText(raw);
      if (/本日/.test(text)) {
        result.add(tokyoTodayIso());
        continue;
      }
      const match = text.match(/(\d{1,2})\/(\d{1,2})/);
      if (!match) continue;
      const month = Number(match[1]);
      const day = Number(match[2]);
      const candidates = [refYear - 1, refYear, refYear + 1]
        .map((year) => {
          const candidate = new Date(Date.UTC(year, month - 1, day));
          if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return undefined;
          return { year, distance: Math.abs(candidate.getTime() - reference.getTime()) };
        })
        .filter((item): item is { year: number; distance: number } => Boolean(item))
        .sort((a, b) => a.distance - b.distance);
      const chosen = candidates[0];
      if (!chosen || chosen.distance > 75 * 24 * 60 * 60 * 1000) continue;
      result.add(`${chosen.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
    return [...result].sort();
  }
}
