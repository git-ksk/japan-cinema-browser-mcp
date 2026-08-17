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
import { assertAeonReviewedExternalUrl, assertOfficialUrl } from "../../providers.js";

const AEON_THEATER_LIST_URL = "https://www.aeoncinema.com/theater/";
const AEON_SCHEDULE_PATH = /^\/theaters\/([a-z0-9_-]+)\/?$/;
const MIN_REVIEWED_THEATER_COUNT = 50;
const THEATER_READY_ATTEMPTS = 20;
const SCHEDULE_READY_ATTEMPTS = 45;
const READY_POLL_MS = 180;
const RENDERED_SCHEDULE_LINK_ATTEMPTS = 16;
const RENDERED_SCHEDULE_LINK_POLL_MS = 500;
const SEAT_READY_ATTEMPTS = 30;
const WATATHEATRE_READY_ATTEMPTS = 30;

export interface AeonTheater extends CinemaTheater<"aeon"> {
  scheduleUrl?: string;
}

export interface AeonTheaterCandidate extends AeonTheater {
  selectionLabel: string;
  searchLabels: string[];
}

export interface AeonShowtime extends CinemaShowtime<"aeon"> {}

interface TheaterSnapshotRow {
  label?: unknown;
  href?: unknown;
  route?: unknown;
  area?: unknown;
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
  scheduleCardCount?: unknown;
  collapsedScheduleCardCount?: unknown;
  invalidScheduleCardCount?: unknown;
}

interface AeonPointSnapshot { x?: unknown; y?: unknown; }

interface AeonCookieSnapshot {
  rejectCount?: unknown;
  allowCount?: unknown;
  settingsCount?: unknown;
  rejectPoint?: AeonPointSnapshot;
}

interface AeonScheduleExpansionState {
  totalCards?: unknown;
  invalidCards?: unknown;
  collapsedMovies?: unknown;
}

interface AeonScheduleExpansionTarget {
  ok?: unknown;
  reason?: unknown;
  movie?: unknown;
  label?: unknown;
  point?: AeonPointSnapshot;
}

interface AeonScheduleExpansionVerification {
  cardCount?: unknown;
  totalTickets?: unknown;
  visibleTickets?: unknown;
}

interface AeonSeatEntrySnapshot {
  matchedRows?: unknown;
  controlCount?: unknown;
  controlLabel?: unknown;
  point?: AeonPointSnapshot;
  context?: unknown;
}

interface AeonWatatheatreSnapshot {
  title?: unknown;
  guestCount?: unknown;
  guestPoint?: AeonPointSnapshot;
  loginFieldCount?: unknown;
  passwordFieldCount?: unknown;
  challengeCount?: unknown;
}

interface AeonSeatSnapshotRow {
  classes?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

interface AeonScreenMarkerSnapshot {
  text?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

interface AeonSeatSnapshot {
  title?: unknown;
  promptCount?: unknown;
  nextControlCount?: unknown;
  bodyText?: unknown;
  seats?: unknown;
  screenMarkers?: unknown;
}

const THEATER_LIST_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
  };
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible);
  const headingCount = headings.filter((el) => normalize(el.textContent) === '劇場を探す').length;
  const rows = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    if (!visible(anchor)) continue;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { continue; }
    if (url.hostname !== 'www.aeoncinema.com' || !/^\\/cinema\\/[a-z0-9_-]+\\/?$/.test(url.pathname)) continue;
    const label = normalize(anchor.getAttribute('aria-label') || anchor.textContent);
    if (!label || label.length > 140) continue;
    const area = anchor.closest('.c-area__area');
    const areaLabel = normalize(area?.querySelector('.c-area__name')?.textContent);
    rows.push({ label, href: url.href, route: '', area: areaLabel });
    if (rows.length >= 160) break;
  }
  return { headingCount, rows };
})()`;


const RENDERED_SCHEDULE_LINK_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const matches = Array.from(document.querySelectorAll('a[href]'))
    .filter((el) => normalize(el.getAttribute('aria-label') || el.textContent) === '上映スケジュールを確認する')
    .filter(visible);
  return {
    matchCount: matches.length,
    href: matches.length === 1 ? matches[0].href : null
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
  const showtimes = [];
  const seen = new Set();
  const scheduleCards = Array.from(document.querySelectorAll('.p-schedule__information')).filter(visible);
  let collapsedScheduleCardCount = 0;
  let invalidScheduleCardCount = 0;
  let ambiguousTimeGroups = 0;

  // Current reviewed AEON schedule UI: only visible tickets inside the same
  // .p-schedule__information card are read truth. Hidden ticket contents are
  // never normalized as showtimes; collapsed cards must be explicitly opened
  // through the reviewed exact 上映時間を見る action first.
  if (scheduleCards.length > 0) {
    for (const card of scheduleCards) {
      const movie = normalize(card.querySelector('.p-schedule__header')?.textContent).replace(/\\s*上映時間[:：].*$/, '').trim();
      const tickets = Array.from(card.querySelectorAll('.p-schedule__ticket'));
      const visibleTickets = tickets.filter(visible);
      const triggers = Array.from(card.querySelectorAll('.p-schedule__listTrigger'))
        .filter(visible)
        .filter((el) => normalize(el.getAttribute('aria-label') || el.textContent) === '上映時間を見る');
      if (!movie || movie.length > 180 || tickets.length === 0) {
        invalidScheduleCardCount += 1;
        continue;
      }
      if (visibleTickets.length === 0) {
        if (triggers.length !== 1) invalidScheduleCardCount += 1;
        else collapsedScheduleCardCount += 1;
        continue;
      }
      if (visibleTickets.length !== tickets.length) {
        invalidScheduleCardCount += 1;
        continue;
      }
      for (const ticket of visibleTickets) {
        const context = normalize(ticket.innerText || ticket.textContent).slice(0, 260);
        const ranges = allTimeRanges(context);
        if (ranges.length !== 1 || !ranges[0]?.[1] || !ranges[0]?.[2]) {
          ambiguousTimeGroups += 1;
          continue;
        }
        const key = movie + '|' + ranges[0][1] + '|' + ranges[0][2];
        if (seen.has(key)) {
          invalidScheduleCardCount += 1;
          continue;
        }
        seen.add(key);
        showtimes.push({ movie, label: ranges[0][1] + '~' + ranges[0][2], context });
        if (showtimes.length >= 180) break;
      }
      if (showtimes.length >= 180) break;
    }
  } else {
    // Legacy reviewed layout fallback. This branch is unreachable whenever the
    // current .p-schedule__information structure is present.
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
    ambiguousTimeGroups = timeItems.filter((item) => item.ranges.length !== 1).length;
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
  }

  const bodyText = normalize((document.querySelector('main') || document.body)?.innerText || '').slice(0, 12000);
  return {
    title: document.title,
    scheduleHeadingCount,
    theaterNames,
    dateLabels,
    showtimes,
    ambiguousTimeGroups,
    scheduleCardCount: scheduleCards.length,
    collapsedScheduleCardCount,
    invalidScheduleCardCount,
    emptySchedule: /(?:上映スケジュールはありません|上映予定はありません|上映回はありません)/.test(bodyText)
  };
})()`;

const AEON_COOKIE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
  };
  const controls = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')).filter(visible);
  const labeled = controls.map((el) => ({ el, label: normalize(el.getAttribute('aria-label') || el.value || el.textContent) }));
  const reject = labeled.filter((item) => item.label === '全て拒否');
  const allow = labeled.filter((item) => item.label === '全て許可');
  const settings = labeled.filter((item) => item.label === 'Cookie設定');
  const point = reject.length === 1 ? (() => { const r = reject[0].el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })() : null;
  return { rejectCount: reject.length, allowCount: allow.length, settingsCount: settings.length, rejectPoint: point };
})()`;

const AEON_SCHEDULE_EXPANSION_STATE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const cards = Array.from(document.querySelectorAll('.p-schedule__information')).filter(visible);
  const collapsedMovies = [];
  let invalidCards = 0;
  for (const card of cards) {
    const movie = normalize(card.querySelector('.p-schedule__header')?.textContent).replace(/\\s*上映時間[:：].*$/, '').trim();
    const tickets = Array.from(card.querySelectorAll('.p-schedule__ticket'));
    const visibleTickets = tickets.filter(visible);
    const triggers = Array.from(card.querySelectorAll('.p-schedule__listTrigger'))
      .filter(visible)
      .filter((el) => normalize(el.getAttribute('aria-label') || el.textContent) === '上映時間を見る');
    if (!movie || tickets.length === 0) {
      invalidCards += 1;
      continue;
    }
    if (visibleTickets.length === tickets.length) continue;
    if (visibleTickets.length !== 0 || triggers.length !== 1) {
      invalidCards += 1;
      continue;
    }
    collapsedMovies.push(movie);
  }
  return { totalCards: cards.length, invalidCards, collapsedMovies };
})()`;

function aeonScheduleExpansionTargetExpression(movie: string): string {
  return `(() => {
    const expectedMovie = ${JSON.stringify(movie)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none';
    };
    const cards = Array.from(document.querySelectorAll('.p-schedule__information')).filter(visible)
      .filter((card) => normalize(card.querySelector('.p-schedule__header')?.textContent).replace(/\\s*上映時間[:：].*$/, '').trim() === expectedMovie);
    if (cards.length !== 1) return { ok: false, reason: 'movie_card_ambiguous', movie: expectedMovie };
    const card = cards[0];
    const tickets = Array.from(card.querySelectorAll('.p-schedule__ticket'));
    const visibleTickets = tickets.filter(visible);
    if (tickets.length === 0 || visibleTickets.length !== 0) return { ok: false, reason: 'movie_not_collapsed', movie: expectedMovie };
    const triggers = Array.from(card.querySelectorAll('.p-schedule__listTrigger'))
      .filter(visible)
      .filter((el) => normalize(el.getAttribute('aria-label') || el.textContent) === '上映時間を見る');
    if (triggers.length !== 1) return { ok: false, reason: 'trigger_ambiguous', movie: expectedMovie };
    const trigger = triggers[0];
    trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = trigger.getBoundingClientRect();
    for (let yi = 1; yi <= 5; yi += 1) {
      for (let xi = 1; xi <= 5; xi += 1) {
        const x = rect.left + rect.width * xi / 6;
        const y = rect.top + rect.height * yi / 6;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        const control = hit?.closest?.('a,button,[role="button"],[role="link"]');
        if (control === trigger) return { ok: true, movie: expectedMovie, label: '上映時間を見る', point: { x, y } };
      }
    }
    return { ok: false, reason: 'trigger_hit_test_failed', movie: expectedMovie };
  })()`;
}

function aeonScheduleExpansionVerificationExpression(movie: string): string {
  return `(() => {
    const expectedMovie = ${JSON.stringify(movie)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const cards = Array.from(document.querySelectorAll('.p-schedule__information')).filter(visible)
      .filter((card) => normalize(card.querySelector('.p-schedule__header')?.textContent).replace(/\\s*上映時間[:：].*$/, '').trim() === expectedMovie);
    if (cards.length !== 1) return { cardCount: cards.length, totalTickets: 0, visibleTickets: 0 };
    const tickets = Array.from(cards[0].querySelectorAll('.p-schedule__ticket'));
    return { cardCount: 1, totalTickets: tickets.length, visibleTickets: tickets.filter(visible).length };
  })()`;
}

function aeonSeatEntryExpression(showtime: AeonShowtime): string {
  const expectedMovie = JSON.stringify(normalizeText(showtime.movie));
  const expectedStart = JSON.stringify(showtime.startTime);
  const expectedEnd = JSON.stringify(showtime.endTime ?? "");
  const expectedScreen = JSON.stringify(showtime.screen ?? "");
  return `(() => {
    const expectedMovie = ${expectedMovie};
    const expectedStart = ${expectedStart};
    const expectedEnd = ${expectedEnd};
    const expectedScreen = ${expectedScreen};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
    };
    const controlLabel = (el) => normalize(el.getAttribute('aria-label') || el.value || el.textContent);
    const cards = Array.from(document.querySelectorAll('.p-schedule__information')).filter(visible);
    const matchedRows = [];
    for (const card of cards) {
      const movie = normalize(card.querySelector('.p-schedule__header')?.textContent).replace(/\\s*上映時間[:：].*$/, '').trim();
      if (movie !== expectedMovie) continue;
      for (const ticket of Array.from(card.querySelectorAll('.p-schedule__ticket')).filter(visible)) {
        const context = normalize(ticket.innerText || ticket.textContent);
        const range = context.match(/((?:[01]?\\d|2\\d)[:：][0-5]\\d)\\s*[~〜～ー-]\\s*((?:[01]?\\d|2\\d)[:：][0-5]\\d)/);
        if (!range?.[1] || !range[2]) continue;
        const start = range[1].replace('：', ':').padStart(5, '0');
        const end = range[2].replace('：', ':').padStart(5, '0');
        if (start !== expectedStart || (expectedEnd && end !== expectedEnd)) continue;
        if (expectedScreen) {
          const compact = context.replace(/\\s+/g, '');
          const screenToken = compact.match(/(?:スクリーン|SCREEN)([0-9A-Za-z_-]+)/i)?.[1] || '';
          if (screenToken.toUpperCase() !== expectedScreen.replace(/\\s+/g, '').toUpperCase()) continue;
        }
        const statuses = Array.from(ticket.querySelectorAll('.p-schedule__status'))
          .filter(visible)
          .filter((el) => normalize(el.textContent) === '予約購入');
        const isTicketButton = ticket.matches('button,[role="button"]') && visible(ticket);
        matchedRows.push({ context, ticket, statuses, isTicketButton });
      }
    }
    const actionable = matchedRows.filter((row) => row.isTicketButton && row.statuses.length === 1);
    const point = actionable.length === 1 ? (() => {
      const status = actionable[0].statuses[0];
      let r = status.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
        actionable[0].ticket.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        r = status.getBoundingClientRect();
      }
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })() : null;
    return {
      matchedRows: matchedRows.length,
      controlCount: actionable.length,
      controlLabel: actionable.length === 1 ? controlLabel(actionable[0].ticket) : null,
      point,
      context: matchedRows.length === 1 ? matchedRows[0].context.slice(0, 700) : null
    };
  })()`;
}

const AEON_WATATHEATRE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
  };
  const controls = Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],input[type="button"],input[type="submit"]')).filter(visible);
  const guests = controls.filter((el) => normalize(el.getAttribute('aria-label') || el.value || el.textContent) === 'チケット購入のみ（会員登録しない）');
  const point = guests.length === 1 ? (() => {
    const guest = guests[0];
    guest.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    const r = guest.getBoundingClientRect();
    for (let yi = 1; yi <= 5; yi += 1) {
      for (let xi = 1; xi <= 5; xi += 1) {
        const x = r.left + r.width * xi / 6;
        const y = r.top + r.height * yi / 6;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        const control = hit?.closest?.('button,a,[role="button"],[role="link"],input[type="button"],input[type="submit"]');
        if (control === guest) return { x, y };
      }
    }
    return null;
  })() : null;
  const fields = Array.from(document.querySelectorAll('input,textarea,select')).filter(visible);
  const challenges = Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenge"],#captcha,input[name*="captcha" i]')).filter(visible);
  return {
    title: document.title,
    guestCount: guests.length,
    guestPoint: point,
    loginFieldCount: fields.length,
    passwordFieldCount: fields.filter((el) => el.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="one-time-code"]')).length,
    challengeCount: challenges.length
  };
})()`;

const AEON_SEAT_MAP_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const actualSeats = [];
  for (const el of Array.from(document.querySelectorAll('.seat')).filter(visible)) {
    const classes = Array.from(el.classList);
    const ids = classes.filter((value) => /^seat-[A-Z]+-\\d+$/.test(value));
    if (ids.length !== 1) continue;
    const r = el.getBoundingClientRect();
    actualSeats.push({ classes, x: r.left, y: r.top, width: r.width, height: r.height });
    if (actualSeats.length >= 1000) break;
  }
  const all = Array.from(document.querySelectorAll('body *')).filter(visible);
  const promptCount = all.filter((el) => normalize(el.textContent) === '座席を選んでください').length;
  const nextControlCount = Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"]'))
    .filter(visible)
    .filter((el) => normalize(el.getAttribute('aria-label') || el.textContent) === '券種選択へ').length;
  const screenMarkers = all
    .filter((el) => !Array.from(el.children).some(visible))
    .map((el) => ({ el, text: normalize(el.textContent) }))
    .filter((item) => /^(?:SCREEN|スクリーン)$/i.test(item.text))
    .slice(0, 8)
    .map((item) => { const r = item.el.getBoundingClientRect(); return { text: item.text, x: r.left, y: r.top, width: r.width, height: r.height }; });
  const root = document.querySelector('main') || document.body;
  const bodyText = normalize(root?.innerText || '').slice(0, 16000);
  return { title: document.title, promptCount, nextControlCount, bodyText, seats: actualSeats, screenMarkers };
})()`;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeAeonTheaterQuery(value: string): string {
  return normalizeText(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^イオンシネマ(?:ズ)?/i, "")
    .toLocaleLowerCase("ja-JP");
}

function matchesAeonTheater(candidate: AeonTheaterCandidate, query: string): boolean {
  const needle = normalizeAeonTheaterQuery(query);
  if (!needle) return false;
  return candidate.searchLabels.some((label) => normalizeAeonTheaterQuery(label).includes(needle));
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
  const { selectionLabel: _selectionLabel, searchLabels: _searchLabels, ...theater } = candidate;
  return theater;
}

function resolvedTheater(candidate: AeonTheaterCandidate, scheduleUrl: string): AeonTheaterCandidate {
  const id = new URL(scheduleUrl).pathname.match(AEON_SCHEDULE_PATH)?.[1];
  if (!id) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON reviewed schedule route no longer exposes a theater slug.", { scheduleUrl });
  }
  return { ...candidate, id, scheduleUrl };
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
    const key = normalizeAeonTheaterQuery(baseName);
    if (!key) continue;
    const existing = byName.get(key);
    if (existing && existing.selectionLabel !== selectionLabel) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON theater name resolves to multiple visible controls.", {
        theater: baseName,
        candidates: [existing.selectionLabel, selectionLabel]
      });
    }
    const area = typeof raw.area === "string" ? normalizeText(raw.area) : "";
    byName.set(key, {
      provider: "aeon",
      id,
      name: `イオンシネマ ${baseName}`,
      sourceUrl,
      ...(scheduleUrl ? { scheduleUrl } : {}),
      selectionLabel,
      searchLabels: [baseName, selectionLabel, ...(area ? [area] : [])]
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

function normalizeFormats(text: string): ShowtimeFormat[] {
  const checks: Array<[RegExp, ShowtimeFormat]> = [
    [/IMAX\s*(?:レーザー|LASER)/i, "IMAX LASER"],
    [/\bIMAX\b/i, "IMAX"],
    [/\b4DX\b/i, "4DX"],
    [/\bMX4D\b/i, "MX4D"],
    [/Dolby\s*Atmos|ドルビーアトモス/i, "DOLBY ATMOS"],
    [/\bTHX\b/i, "THX"],
    [/ULTIRA|ULTILA/i, "ULTIRA"],
    [/D-BOX/i, "D-BOX"],
    [/VSound/i, "VSOUND"],
    [/VIVE\s*AUDIO/i, "VIVE AUDIO"],
    [/dts\s*X/i, "DTS:X"],
    [/(?:^|[\s【\[(])3D(?:[\s】\])]|$)/i, "3D"]
  ];
  const values: ShowtimeFormat[] = [];
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
  const expected = normalizeAeonTheaterQuery(theater.name);
  const title = typeof snapshot.title === "string" ? normalizeText(snapshot.title) : "";
  const titleMatch = title.match(/^上映スケジュール[｜|]\s*(.+?)[｜|]\s*イオンシネマ/);
  if (titleMatch?.[1] && normalizeAeonTheaterQuery(titleMatch[1]) === expected) return true;
  const names = Array.isArray(snapshot.theaterNames)
    ? snapshot.theaterNames.filter((value): value is string => typeof value === "string").map(normalizeAeonTheaterQuery)
    : [];
  return names.includes(expected);
}

function theaterSnapshotReady(snapshot: TheaterSnapshot): boolean {
  return snapshot.headingCount === 1 && Array.isArray(snapshot.rows) && snapshot.rows.length >= MIN_REVIEWED_THEATER_COUNT;
}

function scheduleSnapshotReady(snapshot: ScheduleSnapshot): boolean {
  if (snapshot.scheduleHeadingCount !== 1) return false;
  if (typeof snapshot.invalidScheduleCardCount === "number" && snapshot.invalidScheduleCardCount > 0) return true;
  if (typeof snapshot.collapsedScheduleCardCount === "number" && snapshot.collapsedScheduleCardCount > 0) return true;
  if (typeof snapshot.ambiguousTimeGroups === "number" && snapshot.ambiguousTimeGroups > 0) return true;
  return (Array.isArray(snapshot.showtimes) && snapshot.showtimes.length > 0) || snapshot.emptySchedule === true;
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
  if (typeof snapshot.invalidScheduleCardCount === "number" && snapshot.invalidScheduleCardCount > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON current schedule cards are structurally ambiguous; refusing partial normalization.", {
      invalidScheduleCardCount: snapshot.invalidScheduleCardCount
    });
  }
  if (typeof snapshot.collapsedScheduleCardCount === "number" && snapshot.collapsedScheduleCardCount > 0) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON current schedule still contains collapsed movie cards; hidden ticket content is not read truth.", {
      collapsedScheduleCardCount: snapshot.collapsedScheduleCardCount
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
    const availability = /販売期間外|Web受付終了/.test(semanticText)
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


function rawString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pointFrom(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const point = value as AeonPointSnapshot;
  return finiteNumber(point.x) && finiteNumber(point.y) ? { x: point.x, y: point.y } : undefined;
}

function compactContextText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ja-JP");
}

function aeonMovieContextKey(value: string): string {
  return compactContextText(value)
    .replace(/^\[(?:new|ニュー)\]/i, "")
    .replace(/^(?:字幕版?|吹替版?|字幕|吹替)/, "")
    .replace(/^\[(?:new|ニュー)\]/i, "");
}

function aeonSeatContextMatches(bodyText: string, theater: AeonTheater, showtime: AeonShowtime): boolean {
  const compact = compactContextText(bodyText);
  const theaterKey = normalizeAeonTheaterQuery(theater.name);
  const movieKey = aeonMovieContextKey(showtime.movie);
  const [year, monthRaw, dayRaw] = showtime.date.split("-");
  const month = String(Number(monthRaw));
  const day = String(Number(dayRaw));
  const dateForms = [
    `${year}/${month}/${day}`,
    `${year}年${month}月${day}日`,
    `${month}/${day}`,
    `${month}月${day}日`
  ].map(compactContextText);
  const screenKey = showtime.screen ? compactContextText(showtime.screen) : "";
  const escapedScreen = screenKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactScreen = Boolean(screenKey) && new RegExp(`(?:スクリーン|screen)${escapedScreen}(?![0-9a-z_-])`, "i").test(compact);
  return (
    Boolean(theaterKey) && compact.includes(theaterKey) &&
    Boolean(movieKey) && compact.includes(movieKey) &&
    dateForms.some((candidate) => compact.includes(candidate)) &&
    compact.includes(compactContextText(showtime.startTime)) &&
    exactScreen
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function reviewedAeonScreenEdge(
  markers: unknown,
  seats: Array<{ left: number; top: number; right: number; bottom: number }>
): CinemaSeatMap<"aeon">["screenEdge"] {
  if (!Array.isArray(markers) || markers.length !== 1 || seats.length === 0) return undefined;
  const marker = markers[0] as AeonScreenMarkerSnapshot;
  if (!/^(?:SCREEN|スクリーン)$/i.test(rawString(marker.text))) return undefined;
  if (![marker.x, marker.y, marker.width, marker.height].every(finiteNumber)) return undefined;
  const x = marker.x as number;
  const y = marker.y as number;
  const width = marker.width as number;
  const height = marker.height as number;
  if (width <= 0 || height <= 0) return undefined;
  const left = Math.min(...seats.map((seat) => seat.left));
  const top = Math.min(...seats.map((seat) => seat.top));
  const right = Math.max(...seats.map((seat) => seat.right));
  const bottom = Math.max(...seats.map((seat) => seat.bottom));
  const margin = 2;
  if (y + height <= top - margin) return "top";
  if (y >= bottom + margin) return "bottom";
  if (x + width <= left - margin) return "left";
  if (x >= right + margin) return "right";
  return undefined;
}

export function normalizeAeonSeatSnapshot(
  snapshot: AeonSeatSnapshot,
  sourceUrl: string,
  theater: AeonTheater,
  showtime: AeonShowtime,
  observedAt = new Date().toISOString()
): CinemaSeatMap<"aeon"> {
  let reviewed: URL;
  try {
    reviewed = assertAeonReviewedExternalUrl(sourceUrl, "smart_theater_seat");
  } catch (error) {
    throw new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      error instanceof Error ? error.message : "AEON Smart Theater seat-map URL is outside the reviewed boundary."
    );
  }
  if (normalizeText(rawString(snapshot.title)) !== "e席リザーブ | イオンシネマ") {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON seat-map title no longer matches the reviewed e席リザーブ surface.", { title: snapshot.title });
  }
  if (typeof snapshot.promptCount !== "number" || snapshot.promptCount < 1 || snapshot.promptCount > 4) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON seat-map prompt is missing or implausibly duplicated.", { promptCount: snapshot.promptCount });
  }
  const bodyText = rawString(snapshot.bodyText);
  if (!aeonSeatContextMatches(bodyText, theater, showtime)) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Smart Theater rendered context does not prove the requested theater/movie/date/time/screen.", {
      theater: theater.name,
      movie: showtime.movie,
      date: showtime.date,
      startTime: showtime.startTime,
      screen: showtime.screen
    });
  }
  if (!Array.isArray(snapshot.seats) || snapshot.seats.length < 20 || snapshot.seats.length > 1000) {
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON actual seat identity list is missing or implausible.", {
      count: Array.isArray(snapshot.seats) ? snapshot.seats.length : 0
    });
  }

  const knownClasses = new Set(["seat", "default", "disabled", "active", "normal", "space", "special", "seat-premier", "hc"]);
  type PendingSeat = {
    seat: CinemaSeat;
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  const pending: PendingSeat[] = [];
  const ids = new Set<string>();
  for (const raw of snapshot.seats as AeonSeatSnapshotRow[]) {
    if (!Array.isArray(raw?.classes) || raw.classes.some((item) => typeof item !== "string")) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON seat class list became unreadable.");
    }
    const classes = raw.classes as string[];
    const idTokens = classes.filter((value) => /^seat-[A-Z]+-\d+$/.test(value));
    if (idTokens.length !== 1) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON actual seat identity class became missing or ambiguous.");
    }
    const idMatch = idTokens[0]!.match(/^seat-([A-Z]+)-(\d+)$/);
    if (!idMatch?.[1] || !idMatch[2]) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON actual seat identity is malformed.");
    const id = `${idMatch[1]}-${idMatch[2]}`;
    if (ids.has(id)) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON actual seat identity is duplicated.", { seatId: id });
    ids.add(id);
    if (![raw.x, raw.y, raw.width, raw.height].every(finiteNumber) || (raw.width as number) <= 0 || (raw.height as number) <= 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON actual seat geometry is missing or invalid.", { seatId: id });
    }
    if (classes.includes("active")) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON read-only seat map unexpectedly contains an active/selected seat.", { seatId: id });
    }
    const unknownClass = classes.some((value) => value !== idTokens[0] && !knownClasses.has(value));
    const semanticConflict =
      !classes.includes("seat") ||
      (classes.includes("default") && classes.includes("disabled")) ||
      (classes.includes("normal") && (classes.includes("special") || classes.includes("hc"))) ||
      (classes.includes("seat-premier") && !classes.includes("special")) ||
      (classes.includes("hc") && classes.includes("seat-premier"));
    let state: CinemaSeat["state"] = "unknown";
    if (!unknownClass && !semanticConflict) {
      if (classes.includes("default") && !classes.includes("disabled")) state = "available";
      else if (classes.includes("disabled") && !classes.includes("default")) state = "unavailable";
    }
    const attributes: CinemaSeat["attributes"] = [];
    if (classes.includes("special")) attributes.push("provider:aeon:special");
    if (classes.includes("special") && classes.includes("seat-premier")) attributes.push("premium");
    if (classes.includes("hc")) attributes.push("wheelchair");
    if (classes.includes("space")) attributes.push("provider:aeon:space");
    if (unknownClass) attributes.push("provider:aeon:unreviewed-class");
    const left = raw.x as number;
    const top = raw.y as number;
    const width = raw.width as number;
    const height = raw.height as number;
    pending.push({
      seat: {
        id,
        row: idMatch[1],
        number: idMatch[2],
        state,
        ...(state === "unavailable" ? { unavailableReason: "unknown" as const } : {}),
        attributes,
        x: left,
        y: top
      },
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2
    });
  }

  const heightTolerance = Math.max(2, median(pending.map((item) => item.height)) * 0.45);
  const visualRows: PendingSeat[][] = [];
  for (const item of [...pending].sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX)) {
    const row = visualRows.find((candidate) => Math.abs(median(candidate.map((seat) => seat.centerY)) - item.centerY) <= heightTolerance);
    if (row) row.push(item);
    else visualRows.push([item]);
  }
  visualRows.sort((a, b) => median(a.map((seat) => seat.centerY)) - median(b.map((seat) => seat.centerY)));
  for (let rowIndex = 0; rowIndex < visualRows.length; rowIndex += 1) {
    const row = visualRows[rowIndex]!.sort((a, b) => a.centerX - b.centerX);
    const steps = row.slice(1).map((item, index) => item.centerX - row[index]!.centerX).filter((value) => value > 0);
    const ordinaryStep = median(steps);
    let columnIndex = 0;
    for (let index = 0; index < row.length; index += 1) {
      const current = row[index]!;
      if (index > 0) {
        const previous = row[index - 1]!;
        const delta = current.centerX - previous.centerX;
        const clearGap = ordinaryStep > 0 && delta > ordinaryStep * 1.55 && delta > median([previous.width, current.width]) * 1.8;
        if (clearGap) {
          columnIndex += Math.max(2, Math.round(delta / ordinaryStep));
          previous.seat.rightBoundary = "gap";
          current.seat.leftBoundary = "gap";
        } else {
          columnIndex += 1;
        }
      }
      current.seat.rowIndex = rowIndex;
      current.seat.columnIndex = columnIndex;
    }
  }

  const seatRects = pending.map((item) => ({ left: item.left, top: item.top, right: item.right, bottom: item.bottom }));
  const screenEdge = reviewedAeonScreenEdge(snapshot.screenMarkers, seatRects);
  return {
    provider: "aeon",
    theaterId: theater.id,
    theater: theater.name,
    ...(showtime.screen ? { screen: showtime.screen } : {}),
    showtimeIdentity: ["aeon", theater.id, showtime.date, showtime.movie, showtime.startTime, showtime.endTime ?? "", showtime.screen ?? ""].join("|"),
    seats: pending.map((item) => item.seat),
    ...(screenEdge ? { screenEdge } : {}),
    observedAt,
    sourceUrl: `${reviewed.protocol}//${reviewed.host}${reviewed.pathname}${reviewed.hash}`
  };
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

export class AeonReadAdapter implements CinemaReadAdapter<"aeon", AeonTheater, AeonShowtime>, CinemaSeatReadAdapter<"aeon", AeonTheater, AeonShowtime> {
  constructor(private readonly runtime: CinemaBrowserRuntime) {}

  private async timedPhase<T>(phase: string, task: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    console.info("[japan-cinema-browser-mcp] AEON phase start", { phase });
    try {
      const result = await task();
      console.info("[japan-cinema-browser-mcp] AEON phase complete", {
        phase,
        elapsedMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      console.warn("[japan-cinema-browser-mcp] AEON phase failed", {
        phase,
        elapsedMs: Date.now() - startedAt,
        errorCode: error instanceof BrowserRuntimeError ? error.code : "UNEXPECTED"
      });
      throw error;
    }
  }

  async listTheaters(query?: string): Promise<TheaterListResult<"aeon", AeonTheater>> {
    const candidates = await this.readTheaterCandidates(query);
    return {
      provider: "aeon",
      sourceUrl: candidates.sourceUrl,
      theaters: candidates.theaters.map(publicTheater)
    };
  }

  async getShowtimes(input: ShowtimeQuery): Promise<ShowtimeResult<"aeon", AeonTheater, AeonShowtime>> {
    const candidate = await this.timedPhase("resolve_theater", () => this.resolveTheater(input.theater));
    const baseScheduleUrl = candidate.scheduleUrl ?? await this.timedPhase(
      "open_schedule_public_ui",
      () => this.openScheduleThroughPublicUi(candidate)
    );
    const theater = resolvedTheater(candidate, baseScheduleUrl);
    const date = input.date ?? tokyoTodayIso();
    const targetUrl = buildAeonScheduleUrl(baseScheduleUrl, date);
    const sourceUrl = await this.timedPhase(
      "navigate_dated_schedule",
      () => this.runtime.navigateReviewed(targetUrl, "aeon")
    );
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
    let semantic = await this.timedPhase("read_schedule_semantic", () => this.readScheduleSemantic());
    const currentCardCount = typeof semantic.value.scheduleCardCount === "number" ? semantic.value.scheduleCardCount : 0;
    const currentInvalidCards = typeof semantic.value.invalidScheduleCardCount === "number" ? semantic.value.invalidScheduleCardCount : 0;
    const currentCollapsedCards = typeof semantic.value.collapsedScheduleCardCount === "number" ? semantic.value.collapsedScheduleCardCount : 0;
    if (currentCardCount > 0 && currentInvalidCards > 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON current schedule card structure is ambiguous before any reviewed expansion.", {
        scheduleCardCount: currentCardCount,
        invalidScheduleCardCount: currentInvalidCards
      });
    }
    if (currentCardCount > 0 && currentCollapsedCards > 0) {
      await this.timedPhase("expand_schedule_rows", () => this.expandCurrentScheduleForRead());
      semantic = await this.timedPhase("read_expanded_schedule_semantic", () => this.readScheduleSemantic());
    }
    let showtimes = normalizeAeonScheduleSnapshot(semantic.value, theater, date, semantic.url);
    const dateAvailable = showtimes.length > 0 || semantic.value.emptySchedule === true;
    if (input.movie?.trim()) {
      const needle = normalizeText(input.movie).toLocaleLowerCase("ja-JP");
      showtimes = showtimes.filter((showtime) => showtime.movie.toLocaleLowerCase("ja-JP").includes(needle));
    }
    return {
      provider: "aeon",
      theater: publicTheater(theater),
      date,
      dateAvailable,
      availableDates: this.normalizeAvailableDates(semantic.value.dateLabels, date),
      sourceUrl: semantic.url,
      showtimes
    };
  }

  async getSeatAvailability(input: SeatAvailabilityQuery): Promise<SeatAvailabilityResult<"aeon", AeonTheater, AeonShowtime>> {
    if (!/^\d{2}:\d{2}$/.test(input.startTime)) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "AEON seat availability requires an exact 24-hour showtime startTime.");
    }
    const schedule = await this.getShowtimes({ theater: input.theater, date: input.date, movie: input.movie });
    if (!schedule.dateAvailable) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "AEON requested seat-availability date is not exposed by the current public schedule.", { date: input.date });
    }
    let matches = schedule.showtimes.filter((showtime) => showtime.startTime === input.startTime);
    if (input.screen?.trim()) matches = matches.filter((showtime) => showtime.screen === input.screen!.trim());
    if (matches.length !== 1) {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "AEON showtime did not resolve to one unique rendered schedule row for seat availability.", {
        movie: input.movie,
        startTime: input.startTime,
        screen: input.screen,
        candidates: matches.slice(0, 8).map((showtime) => ({ movie: showtime.movie, startTime: showtime.startTime, screen: showtime.screen }))
      });
    }
    const showtime = matches[0]!;
    if (!showtime.screen) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON seat availability requires an observed screen identity from the rendered schedule row.");
    }
    if (showtime.availability === "sold_out" || showtime.availability === "unavailable") {
      throw new BrowserRuntimeError("UI_ELEMENT_NOT_FOUND", "AEON showtime is not currently represented as a sellable seat-map entry.", { availability: showtime.availability });
    }

    const cookie = await this.runtime.evaluateAeonSeatScheduleState<AeonCookieSnapshot>(AEON_COOKIE_EXPRESSION);
    const rejectCount = typeof cookie.value.rejectCount === "number" ? cookie.value.rejectCount : 0;
    const allowCount = typeof cookie.value.allowCount === "number" ? cookie.value.allowCount : 0;
    const settingsCount = typeof cookie.value.settingsCount === "number" ? cookie.value.settingsCount : 0;
    if (rejectCount > 1 || allowCount > 1 || settingsCount > 1) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie controls are ambiguous; refusing automated consent handling.", {
        rejectCount, allowCount, settingsCount
      });
    }
    if (rejectCount === 1) {
      const rejectPoint = pointFrom(cookie.value.rejectPoint);
      if (!rejectPoint) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON exact `全て拒否` Cookie control has no usable rendered pointer geometry.");
      await this.runtime.clickAeonCookieReject(rejectPoint);
      let dismissed = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const next = await this.runtime.evaluateAeonSeatScheduleState<AeonCookieSnapshot>(AEON_COOKIE_EXPRESSION);
        const nextReject = typeof next.value.rejectCount === "number" ? next.value.rejectCount : 0;
        const nextAllow = typeof next.value.allowCount === "number" ? next.value.allowCount : 0;
        const nextSettings = typeof next.value.settingsCount === "number" ? next.value.settingsCount : 0;
        if (nextReject === 0 && nextAllow === 0 && nextSettings === 0) {
          dismissed = true;
          break;
        }
        if (nextReject > 1 || nextAllow > 1 || nextSettings > 1 || nextReject === 0) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie surface changed to an unreviewed state after exact rejection.");
        }
        await sleep(READY_POLL_MS);
      }
      if (!dismissed) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie overlay did not dismiss after the exact privacy-preserving rejection action.");
    } else if (allowCount > 0 || settingsCount > 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie surface is visible without one exact `全て拒否` control; refusing consent automation.");
    }

    const entry = await this.runtime.evaluateAeonSeatScheduleState<AeonSeatEntrySnapshot>(aeonSeatEntryExpression(showtime));
    if (entry.value.matchedRows !== 1 || entry.value.controlCount !== 1) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON requested showtime is no longer represented by one exact rendered `予約購入` control.", {
        matchedRows: entry.value.matchedRows,
        controlCount: entry.value.controlCount
      });
    }
    const entryPoint = pointFrom(entry.value.point);
    const entryControlLabel = rawString(entry.value.controlLabel);
    if (!entryPoint || !entryControlLabel || !entryControlLabel.endsWith("予約購入")) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON exact reservation control has no usable rendered pointer geometry/label.");
    }
    await this.runtime.clickAeonSeatEntryAndAdoptWatatheatre(entryPoint, entryControlLabel);

    let watatheatre: { url: string; value: AeonWatatheatreSnapshot } | undefined;
    for (let attempt = 0; attempt < WATATHEATRE_READY_ATTEMPTS; attempt += 1) {
      watatheatre = await this.runtime.evaluateAeonReviewedTargetState<AeonWatatheatreSnapshot>("watatheatre", AEON_WATATHEATRE_EXPRESSION);
      if (watatheatre.value.challengeCount && watatheatre.value.challengeCount !== 0) {
        throw new BrowserRuntimeError("HUMAN_ACTION_REQUIRED", "AEON Watatheatre exposed an access challenge; read-only automation will not bypass it.");
      }
      if (watatheatre.value.guestCount === 1 && pointFrom(watatheatre.value.guestPoint)) break;
      if (typeof watatheatre.value.guestCount === "number" && watatheatre.value.guestCount > 1) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Watatheatre non-member continuation became ambiguous.", { count: watatheatre.value.guestCount });
      }
      await sleep(READY_POLL_MS);
    }
    const guestPoint = watatheatre ? pointFrom(watatheatre.value.guestPoint) : undefined;
    if (!watatheatre || watatheatre.value.guestCount !== 1 || !guestPoint) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Watatheatre did not expose one exact non-member continuation within the bounded wait.");
    }
    await this.runtime.clickAeonGuestPurchaseAndWaitForSeat(guestPoint);

    let seatSemantic: { url: string; value: AeonSeatSnapshot } | undefined;
    for (let attempt = 0; attempt < SEAT_READY_ATTEMPTS; attempt += 1) {
      seatSemantic = await this.runtime.evaluateAeonReviewedTargetState<AeonSeatSnapshot>("smart_theater_seat", AEON_SEAT_MAP_EXPRESSION);
      const count = Array.isArray(seatSemantic.value.seats) ? seatSemantic.value.seats.length : 0;
      if (
        normalizeText(rawString(seatSemantic.value.title)) === "e席リザーブ | イオンシネマ" &&
        typeof seatSemantic.value.promptCount === "number" &&
        seatSemantic.value.promptCount >= 1 && seatSemantic.value.promptCount <= 4 &&
        count >= 20
      ) break;
      await sleep(READY_POLL_MS);
    }
    if (!seatSemantic) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Smart Theater seat surface did not hydrate.");
    const seatMap = normalizeAeonSeatSnapshot(seatSemantic.value, seatSemantic.url, schedule.theater, showtime);
    return { provider: "aeon", theater: schedule.theater, showtime, seatMap };
  }

  private async readTheaterCandidates(query?: string): Promise<{ sourceUrl: string; theaters: AeonTheaterCandidate[] }> {
    const status = await this.timedPhase("theater_list_status", () => this.runtime.status());
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!isTheaterListUrl(currentUrl)) {
      await this.timedPhase(
        "navigate_theater_list",
        () => this.runtime.navigateReviewed(AEON_THEATER_LIST_URL, "aeon")
      );
    }
    let semantic: { url: string; value: TheaterSnapshot } | undefined;
    await this.timedPhase("read_theater_list_semantic", async () => {
      for (let attempt = 0; attempt < THEATER_READY_ATTEMPTS; attempt += 1) {
        semantic = await this.runtime.evaluateSemanticState<TheaterSnapshot>("aeon", THEATER_LIST_EXPRESSION);
        if (theaterSnapshotReady(semantic.value)) break;
        await sleep(READY_POLL_MS);
      }
    });
    if (!semantic || !theaterSnapshotReady(semantic.value)) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON theater list did not reach the reviewed semantic ready state.");
    }
    let theaters = normalizeAeonTheaterSnapshot(semantic.value, semantic.url);
    if (query?.trim()) {
      theaters = theaters.filter((theater) => matchesAeonTheater(theater, query));
    }
    return { sourceUrl: semantic.url, theaters };
  }

  private async dismissAeonCookieForReviewedSchedule(): Promise<void> {
    const cookie = await this.runtime.evaluateAeonSeatScheduleState<AeonCookieSnapshot>(AEON_COOKIE_EXPRESSION);
    const rejectCount = typeof cookie.value.rejectCount === "number" ? cookie.value.rejectCount : 0;
    const allowCount = typeof cookie.value.allowCount === "number" ? cookie.value.allowCount : 0;
    const settingsCount = typeof cookie.value.settingsCount === "number" ? cookie.value.settingsCount : 0;
    if (rejectCount > 1 || allowCount > 1 || settingsCount > 1) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie controls are ambiguous before schedule expansion.", { rejectCount, allowCount, settingsCount });
    }
    if (rejectCount === 0) {
      if (allowCount > 0 || settingsCount > 0) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie surface is visible without one exact `全て拒否` control; refusing schedule expansion.");
      }
      return;
    }
    const rejectPoint = pointFrom(cookie.value.rejectPoint);
    if (!rejectPoint) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON exact `全て拒否` Cookie control has no usable rendered pointer geometry.");
    await this.runtime.clickAeonCookieReject(rejectPoint);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const next = await this.runtime.evaluateAeonSeatScheduleState<AeonCookieSnapshot>(AEON_COOKIE_EXPRESSION);
      const r = typeof next.value.rejectCount === "number" ? next.value.rejectCount : 0;
      const a = typeof next.value.allowCount === "number" ? next.value.allowCount : 0;
      const s = typeof next.value.settingsCount === "number" ? next.value.settingsCount : 0;
      if (r === 0 && a === 0 && s === 0) return;
      if (r !== 1 || a > 1 || s > 1) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie surface changed to an unreviewed state after exact rejection.");
      await sleep(READY_POLL_MS);
    }
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON Cookie overlay did not dismiss after the exact privacy-preserving rejection action.");
  }

  private async expandCurrentScheduleForRead(): Promise<void> {
    await this.dismissAeonCookieForReviewedSchedule();
    const state = await this.runtime.evaluateAeonSeatScheduleState<AeonScheduleExpansionState>(AEON_SCHEDULE_EXPANSION_STATE_EXPRESSION);
    const totalCards = typeof state.value.totalCards === "number" ? state.value.totalCards : 0;
    const invalidCards = typeof state.value.invalidCards === "number" ? state.value.invalidCards : -1;
    const movies = Array.isArray(state.value.collapsedMovies)
      ? state.value.collapsedMovies.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (totalCards < 1 || totalCards > 160 || invalidCards !== 0 || movies.length > totalCards || new Set(movies).size !== movies.length) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON collapsed schedule cards are missing, ambiguous, or internally inconsistent.", { totalCards, invalidCards, collapsedCount: movies.length });
    }
    for (const movie of movies) {
      const first = await this.runtime.evaluateAeonSeatScheduleState<AeonScheduleExpansionTarget>(aeonScheduleExpansionTargetExpression(movie));
      if (first.value.ok !== true || rawString(first.value.movie) !== movie || rawString(first.value.label) !== "上映時間を見る") {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON exact schedule expansion target could not be resolved before settling.", { movie, reason: first.value.reason });
      }
      await sleep(READY_POLL_MS);
      const second = await this.runtime.evaluateAeonSeatScheduleState<AeonScheduleExpansionTarget>(aeonScheduleExpansionTargetExpression(movie));
      const point = pointFrom(second.value.point);
      if (second.value.ok !== true || rawString(second.value.movie) !== movie || rawString(second.value.label) !== "上映時間を見る" || !point) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON exact schedule expansion target changed before trusted pointer dispatch.", { movie, reason: second.value.reason });
      }
      await this.runtime.clickAeonScheduleExpansion(point);
      let expanded = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const verify = await this.runtime.evaluateAeonSeatScheduleState<AeonScheduleExpansionVerification>(aeonScheduleExpansionVerificationExpression(movie));
        const cardCount = typeof verify.value.cardCount === "number" ? verify.value.cardCount : 0;
        const totalTickets = typeof verify.value.totalTickets === "number" ? verify.value.totalTickets : 0;
        const visibleTickets = typeof verify.value.visibleTickets === "number" ? verify.value.visibleTickets : 0;
        if (cardCount === 1 && totalTickets > 0 && visibleTickets === totalTickets) { expanded = true; break; }
        if (cardCount !== 1 || totalTickets <= 0 || visibleTickets > totalTickets) {
          throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule card changed to an invalid state after one exact expansion.", { movie, cardCount, totalTickets, visibleTickets });
        }
        await sleep(READY_POLL_MS);
      }
      if (!expanded) throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule card did not fully expand after one exact reviewed action; refusing a repeated click.", { movie });
    }
    const finalState = await this.runtime.evaluateAeonSeatScheduleState<AeonScheduleExpansionState>(AEON_SCHEDULE_EXPANSION_STATE_EXPRESSION);
    const finalInvalid = typeof finalState.value.invalidCards === "number" ? finalState.value.invalidCards : -1;
    const finalCollapsed = Array.isArray(finalState.value.collapsedMovies) ? finalState.value.collapsedMovies.length : -1;
    if (finalInvalid !== 0 || finalCollapsed !== 0) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule remained partially collapsed after bounded reviewed expansion.", { finalInvalid, finalCollapsed });
    }
  }

  private async readScheduleSemantic(): Promise<{ url: string; value: ScheduleSnapshot }> {
    let semantic: { url: string; value: ScheduleSnapshot } | undefined;
    for (let attempt = 0; attempt < SCHEDULE_READY_ATTEMPTS; attempt += 1) {
      semantic = await this.runtime.evaluateSemanticState<ScheduleSnapshot>("aeon", SCHEDULE_EXPRESSION);
      if (scheduleSnapshotReady(semantic.value)) return semantic;
      await sleep(READY_POLL_MS);
    }
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON schedule did not reach a recognizable rendered semantic state.", {
      scheduleHeadingCount: semantic?.value.scheduleHeadingCount,
      showtimeCount: Array.isArray(semantic?.value.showtimes) ? semantic.value.showtimes.length : undefined,
      scheduleCardCount: semantic?.value.scheduleCardCount
    });
  }

  private async resolveTheater(query: string): Promise<AeonTheaterCandidate> {
    const result = await this.readTheaterCandidates(query);
    const needle = normalizeAeonTheaterQuery(query);
    const exact = result.theaters.filter((theater) => normalizeAeonTheaterQuery(theater.name) === needle);
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
    const theaterClick = await this.timedPhase(
      "click_theater_control",
      () => this.runtime.clickReviewedControl(theater.selectionLabel, "aeon")
    );
    const clickedUrl = typeof theaterClick.url === "string" ? theaterClick.url : undefined;
    const direct = clickedUrl ? scheduleUrlFromCurrent(clickedUrl) : undefined;
    if (direct) return direct;

    const renderedScheduleUrl = await this.timedPhase(
      "read_rendered_schedule_link",
      () => this.readRenderedScheduleUrl()
    );
    if (renderedScheduleUrl) return renderedScheduleUrl;

    await this.timedPhase(
      "click_schedule_control",
      () => this.clickControlWhenAvailable("上映スケジュールを確認する", 20)
    );
    const scheduleUrl = await this.timedPhase(
      "wait_schedule_url",
      () => this.waitForScheduleUrl(24, READY_POLL_MS)
    );
    if (!scheduleUrl) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON public theater selection did not resolve to a reviewed schedule page.", {
        theater: theater.name
      });
    }
    return scheduleUrl;
  }

  private async readRenderedScheduleUrl(): Promise<string | undefined> {
    for (let attempt = 0; attempt < RENDERED_SCHEDULE_LINK_ATTEMPTS; attempt += 1) {
      const semantic = await this.runtime.evaluateSemanticState<{ matchCount?: unknown; href?: unknown }>(
        "aeon",
        RENDERED_SCHEDULE_LINK_EXPRESSION
      );
      const matchCount = typeof semantic.value.matchCount === "number" ? semantic.value.matchCount : 0;
      if (matchCount > 1) {
        throw new BrowserRuntimeError(
          "UI_STATE_CHANGED",
          "AEON rendered schedule control is no longer unique on the public theater page.",
          { matchCount }
        );
      }
      if (typeof semantic.value.href === "string" && semantic.value.href) {
        const scheduleUrl = scheduleRouteFromValue(semantic.value.href);
        if (!scheduleUrl) {
          throw new BrowserRuntimeError(
            "UI_STATE_CHANGED",
            "AEON rendered schedule control no longer points to the reviewed public schedule route."
          );
        }
        return scheduleUrl;
      }
      await sleep(RENDERED_SCHEDULE_LINK_POLL_MS);
    }
    return undefined;
  }

  private async clickControlWhenAvailable(label: string, attempts: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.runtime.clickReviewedControl(label, "aeon");
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof BrowserRuntimeError) || error.code !== "UI_ELEMENT_NOT_FOUND") throw error;
        await sleep(READY_POLL_MS);
      }
    }
    throw new BrowserRuntimeError("UI_STATE_CHANGED", "AEON expected public navigation control did not become uniquely available.", {
      label,
      cause: lastError instanceof Error ? lastError.message : String(lastError)
    });
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
