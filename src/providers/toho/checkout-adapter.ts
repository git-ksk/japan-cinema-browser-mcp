import {
  BrowserRuntimeError,
  type CinemaBrowserRuntime,
  type CinemaHandoffAction,
  type CinemaReviewedBrowserContext
} from "../../browser/runtime.js";
import type { CinemaSeatMap, CinemaSeatReadAdapter, SeatAvailabilityQuery } from "../../cinema.js";
import {
  CheckoutCoreError,
  currentCheckoutSeatFingerprints,
  parseCinemaCheckoutIntent,
  resolveCheckoutTicketChoices,
  validateCheckoutSeatIntent,
  type CinemaCheckoutIntent,
  type CinemaRenderedTicketType,
  type CinemaResolvedTicketChoice
} from "../../checkout.js";
import { checkoutIntentDigest, type CheckoutContinuationBinding, type CheckoutContinuationBindingInput } from "../../checkout-continuation.js";
import { compareCinemaSeatObservations } from "../../seat-freshness.js";
import {
  TOHO_SEAT_MAP_EXPRESSION,
  TohoReadAdapter,
  normalizeTohoSeatSnapshot,
  type TohoSeatSnapshot,
  type TohoShowtime,
  type TohoTheater
} from "./adapter.js";

const TOHO_CONSENT_NEXT_LABEL = "利用規約に同意して次へ";
const TOHO_MIN_DESKTOP_MUTATION_WIDTH = 1024;

interface TohoCheckoutRuntime {
  evaluateSemanticState<T>(expectedProvider: "toho", expression: string): Promise<{ url: string; value: T }>;
  clickReviewedElementPoint(
    point: { x: number; y: number },
    expectedProvider: "toho",
    expectedElement: { tagName: string; id?: string; text?: string; href?: string; dataModal?: string }
  ): Promise<Record<string, unknown>>;
  getReviewedBrowserContext(expectedProvider: "toho"): Promise<CinemaReviewedBrowserContext>;
  consumeTohoGate1TicketProof(input: { seatId: string; intentDigest: string }): Promise<CinemaReviewedBrowserContext>;
  createCheckoutContinuation(input: CheckoutContinuationBindingInput): CheckoutContinuationBinding;
  requireReviewedHumanIntervention(input: {
    reason: "consent";
    action: CinemaHandoffAction;
    message: string;
  }): Promise<never>;
}

interface TohoSeatClickTarget {
  ok?: unknown;
  reason?: unknown;
  id?: unknown;
  tagName?: unknown;
  src?: unknown;
  alt?: unknown;
  x?: unknown;
  y?: unknown;
}

interface TohoPostSelectionBoundarySnapshot {
  orientationBlocked?: unknown;
  confirm?: unknown;
  exactConsentNextControls?: unknown;
  sensitiveFields?: unknown;
  visibleLabels?: unknown;
}

interface TohoCheckoutLayoutSnapshot {
  width?: unknown;
  height?: unknown;
  orientationBlocked?: unknown;
}


function exactSeatClickTargetExpression(seatId: string): string {
  if (!/^[A-Z]+-\d+$/.test(seatId)) {
    throw new CheckoutCoreError("INVALID_INTENT", "TOHO seat identity is outside the reviewed rendered format.", { seatId });
  }
  const [row, number] = seatId.split("-");
  return `(() => {
    const id = ${JSON.stringify(seatId)};
    const row = ${JSON.stringify(row)};
    const number = ${JSON.stringify(number)};
    const root = document.querySelector('#screen-list-frame-inner');
    const seat = document.getElementById(id);
    if (!root || !seat || !root.contains(seat) || seat.tagName !== 'IMG') return { ok: false, reason: 'seat_missing' };
    let src = '';
    try { src = new URL(seat.src, location.href).pathname.split('/').pop() || ''; } catch {}
    const alt = String(seat.getAttribute('alt') || '').trim();
    const onclick = String(seat.getAttribute('onclick') || '').trim();
    const expectedClick = new RegExp("^JavaScript:seatSelect\\\\('" + row + "','" + number + "',\\\\s*'\\\\d+'\\\\);$");
    if (src !== 'seat_1.gif' || alt !== id + ' 空席(選択可)' || !expectedClick.test(onclick)) {
      return { ok: false, reason: 'seat_not_exact_ordinary_available', id, src, alt };
    }
    seat.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = seat.getBoundingClientRect();
    const style = getComputedStyle(seat);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    const exactHit = hit === seat;
    return { ok: visible && exactHit, reason: visible && exactHit ? null : 'seat_hit_test_failed', id, tagName: seat.tagName, src, alt, x, y };
  })()`;
}

const TOHO_CHECKOUT_LAYOUT_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const body = normalize(document.body?.innerText || '');
  return {
    width: innerWidth,
    height: innerHeight,
    orientationBlocked: body.includes('このページはディスプレイを横にしたままご利用いただけません。')
  };
})()`;

const TOHO_POST_SELECTION_BOUNDARY_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
  };
  const body = normalize(document.body?.innerText || '');
  const confirmEl = document.getElementById('fooder_menu_conf_bt');
  let confirm = null;
  if (confirmEl) {
    const rect = confirmEl.getBoundingClientRect();
    const style = getComputedStyle(confirmEl);
    confirm = {
      id: String(confirmEl.id || ''),
      tagName: String(confirmEl.tagName || ''),
      className: String(confirmEl.className || ''),
      label: normalize(confirmEl.getAttribute('aria-label') || confirmEl.textContent),
      interactive: visible(confirmEl),
      width: rect.width,
      height: rect.height,
      pointerEvents: String(style.pointerEvents || '')
    };
  }
  const controls = Array.from(document.querySelectorAll('button,a,input[type="button"],input[type="submit"]'))
    .filter(visible)
    .map((el) => normalize(el.getAttribute('aria-label') || el.value || el.textContent));
  const sensitiveFields = Array.from(document.querySelectorAll('input')).filter((el) => {
    if (!visible(el)) return false;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    const label = normalize(el.getAttribute('aria-label') || el.getAttribute('name') || el.id).toLowerCase();
    return type === 'password' || autocomplete === 'one-time-code' || /otp|認証コード|verification|card|カード|cvv|cvc|security/.test(label);
  });
  return {
    orientationBlocked: body.includes('このページはディスプレイを横にしたままご利用いただけません。'),
    confirm,
    exactConsentNextControls: controls.filter((label) => label === '利用規約に同意して次へ').length,
    sensitiveFields: sensitiveFields.length,
    visibleLabels: controls.filter((label) => /確認する|利用規約|次へ/.test(label)).slice(0, 8)
  };
})()`;


const TOHO_REVIEWED_TICKET_LABELS = [
  "一般",
  "大学・専門",
  "高校生",
  "中学・小学",
  "幼児（３才以上）",
  "シニア（６０才以上）",
  "障がい者割引（一般・大専）",
  "障がい者割引（高校生以下）"
] as const;

const TOHO_REVIEWED_TICKET_LABEL_SET = new Set<string>(TOHO_REVIEWED_TICKET_LABELS);
const TOHO_TICKET_ID = /^\d{3}-\d{4}-\d{4}-\d$/;
const TOHO_TICKET_HREF = /^javascript:SelectTicket\.setTicket\('(\d+)',\s*'(\d+)',\s*'([^']+)',\s*'([^']+)',\s*'([\d,]+円)'\)$/;

interface TohoTicketOptionSnapshot {
  text?: unknown;
  href?: unknown;
}

interface TohoTicketSlotSnapshot {
  seatLabel?: unknown;
  modalTarget?: unknown;
  selectTicketValue?: unknown;
  selectionText?: unknown;
  options?: unknown;
  onaVisible?: unknown;
  onaText?: unknown;
  onaRadioCount?: unknown;
  campaignVisible?: unknown;
  campaignText?: unknown;
  movieTicketVisible?: unknown;
  movieTicketText?: unknown;
  limitedTicket?: unknown;
}

export interface TohoTicketStageSnapshot {
  title?: unknown;
  pathname?: unknown;
  formName?: unknown;
  formMethod?: unknown;
  formActionPathname?: unknown;
  ticketSiteCd?: unknown;
  tsize?: unknown;
  iValue?: unknown;
  hTotal?: unknown;
  totalText?: unknown;
  ajaxActive?: unknown;
  formErrorVisible?: unknown;
  formErrorText?: unknown;
  guestControls?: unknown;
  slots?: unknown;
}

export interface TohoNormalizedTicketStage {
  provider: "toho";
  siteId: string;
  seatId: string;
  selectedProviderTicketTypeId?: string;
  selectionText: string;
  ticketTypes: CinemaRenderedTicketType[];
  totalYen: number;
  ajaxActive: number;
  extraConditionReasons: string[];
  guestContinuation: {
    label: "ログインせず次へ";
    href: "javascript:void(0)";
    onclick: string;
  };
}

export interface TohoTicketSelectionResult {
  provider: "toho";
  stage: "member_or_guest";
  seatId: string;
  selected: CinemaResolvedTicketChoice;
  totalYen: number;
  guestContinuationReady: true;
  neverReplay: true;
}

export const TOHO_TICKET_STAGE_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const pathname = location.pathname;
  const form = document.forms.purchaseContentsConfirmIntForm;
  const slotElements = Array.from(document.querySelectorAll('.ticket-item'));
  const selectTickets = Array.from(document.querySelectorAll('.select_ticket'));
  const slots = slotElements.map((item, index) => {
    const seatLabel = normalize(item.innerText).split(' ')[0] || '';
    const modalAnchors = Array.from(item.querySelectorAll('a[data-modal]'));
    const modalTarget = modalAnchors.length === 1 ? String(modalAnchors[0].getAttribute('data-modal') || '') : '';
    const modal = modalTarget ? document.querySelector('[data-modal-content="' + modalTarget.replace(/"/g, '\\"') + '"]') : null;
    const options = modal ? Array.from(modal.querySelectorAll('a[href^="javascript:SelectTicket.setTicket"]')).map((el) => ({
      text: normalize(el.textContent),
      href: String(el.getAttribute('href') || '')
    })) : [];
    const suffix = '0' + index;
    const selectionRoots = Array.from(item.querySelectorAll('.ticket-content'));
    const selectionRoot = selectionRoots.length === 1 ? selectionRoots[0] : null;
    const ona = document.getElementById('onaRadioDiv' + suffix);
    const campaign = document.getElementById('kessaiCampaign' + suffix);
    const movieTicket = document.getElementById('movieticket' + suffix);
    const limited = document.getElementById('limitedTicket' + suffix);
    return {
      seatLabel,
      modalTarget,
      selectTicketValue: selectTickets[index] ? String(selectTickets[index].value || '') : '',
      selectionText: normalize(selectionRoot?.innerText || ''),
      options,
      onaVisible: visible(ona),
      onaText: normalize(ona?.innerText || ''),
      onaRadioCount: ona ? ona.querySelectorAll('input[type="radio"]').length : 0,
      campaignVisible: visible(campaign),
      campaignText: normalize(campaign?.innerText || ''),
      movieTicketVisible: visible(movieTicket),
      movieTicketText: normalize(movieTicket?.innerText || ''),
      limitedTicket: normalize(limited?.textContent || '')
    };
  });
  const guests = Array.from(document.querySelectorAll('a')).filter((el) => visible(el) && normalize(el.textContent) === 'ログインせず次へ').map((el) => ({
    label: normalize(el.textContent),
    href: String(el.getAttribute('href') || ''),
    onclick: String(el.getAttribute('onclick') || '')
  }));
  const formError = document.querySelector('.form-error.is-expand');
  let actionPathname = '';
  try { actionPathname = form ? new URL(form.action, location.href).pathname : ''; } catch {}
  return {
    title: document.title,
    pathname,
    formName: form ? String(form.name || '') : '',
    formMethod: form ? String(form.method || '').toLowerCase() : '',
    formActionPathname: actionPathname,
    ticketSiteCd: form?.elements?.ticket_site_cd ? String(form.elements.ticket_site_cd.value || '') : '',
    tsize: form?.elements?.tsize ? String(form.elements.tsize.value || '') : '',
    iValue: form?.elements?.iValue ? String(form.elements.iValue.value || '') : '',
    hTotal: form?.elements?.hTotal ? String(form.elements.hTotal.value || '') : '',
    totalText: normalize(document.querySelector('.form-ticket .total')?.innerText || ''),
    ajaxActive: Number(window.jQuery && Number.isFinite(window.jQuery.active) ? window.jQuery.active : -1),
    formErrorVisible: visible(formError),
    formErrorText: normalize(formError?.innerText || ''),
    guestControls: guests,
    slots
  };
})()`;

function parseYenText(value: string): number | undefined {
  const match = /^(\d{1,3}(?:,\d{3})*)円$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]!.replace(/,/g, ''));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

function formatYen(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;
}

function compactTohoSeatId(seatId: string): string {
  const match = /^([A-Z]{1,4})-(\d{1,4})$/.exec(seatId);
  if (!match) throw new CheckoutCoreError("INVALID_INTENT", "TOHO B2 seat identity is outside the reviewed format.", { seatId });
  return `${match[1]}${match[2]}`;
}

function ticketHumanReview(label: string): Pick<CinemaRenderedTicketType, "humanReviewRequired" | "humanReviewReason" | "eligibilityText"> {
  if (label === "一般") return {};
  return {
    humanReviewRequired: true,
    humanReviewReason: "ticket_eligibility",
    eligibilityText: label
  };
}

export function normalizeTohoTicketStageSnapshot(
  snapshot: TohoTicketStageSnapshot,
  expectedSeatId: string
): TohoNormalizedTicketStage {
  if (snapshot.title !== "チケットの種類 || TOHOシネマズ") {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket-stage title changed from the reviewed J02 surface.");
  }
  const pathname = typeof snapshot.pathname === "string" ? snapshot.pathname : "";
  const route = /^\/net\/ticket\/(\d{3})\/TNPI2010J02\.do$/.exec(pathname);
  if (!route) throw new CheckoutCoreError("STALE_CONTEXT", "TOHO ticket-stage route is not the reviewed J02 surface.");
  const siteId = route[1]!;
  if (
    snapshot.formName !== "purchaseContentsConfirmIntForm" || snapshot.formMethod !== "post" ||
    snapshot.formActionPathname !== `/net/ticket/${siteId}/TNPI2030J02.do` || snapshot.ticketSiteCd !== siteId
  ) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket-stage form identity or continuation action changed.");
  }
  if (snapshot.tsize !== "1" || snapshot.iValue !== "2") {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 initial vertical slice requires exactly one rendered seat/ticket slot.", {
      tsize: snapshot.tsize,
      iValue: snapshot.iValue
    });
  }
  const slots = Array.isArray(snapshot.slots) ? snapshot.slots as TohoTicketSlotSnapshot[] : [];
  if (slots.length !== 1) throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 requires one exact rendered ticket slot.");
  const slot = slots[0]!;
  const compactSeat = compactTohoSeatId(expectedSeatId);
  if (slot.seatLabel !== compactSeat || slot.modalTarget !== "modal-target-00") {
    throw new CheckoutCoreError("STALE_CONTEXT", "TOHO ticket slot no longer matches the exact Gate 1 seat.", {
      expectedSeat: compactSeat,
      observedSeat: slot.seatLabel,
      modalTarget: slot.modalTarget
    });
  }
  const selectTicketValue = typeof slot.selectTicketValue === "string" ? slot.selectTicketValue : "";
  if (selectTicketValue !== "-0--" && !TOHO_TICKET_ID.test(selectTicketValue)) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket slot contains an unreviewed selected-ticket identity.", { selectTicketValue });
  }
  for (const [name, value] of [
    ["onaVisible", slot.onaVisible],
    ["campaignVisible", slot.campaignVisible],
    ["movieTicketVisible", slot.movieTicketVisible]
  ] as const) {
    if (typeof value !== "boolean") throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", `TOHO B2 ${name} state is missing or invalid.`);
  }
  if (!Number.isInteger(slot.onaRadioCount) || Number(slot.onaRadioCount) < 0) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 additional-format control count is missing or invalid.");
  }
  if (slot.limitedTicket !== "0" && slot.limitedTicket !== "1" && slot.limitedTicket !== "") {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 limited-ticket marker is outside the reviewed values.");
  }
  const rawOptions = Array.isArray(slot.options) ? slot.options as TohoTicketOptionSnapshot[] : [];
  if (rawOptions.length < 1 || rawOptions.length > 32) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket modal did not expose a bounded reviewed option list.");
  }
  const ticketTypes: CinemaRenderedTicketType[] = [];
  const identities = new Set<string>();
  for (const option of rawOptions) {
    const text = typeof option.text === "string" ? option.text : "";
    const href = typeof option.href === "string" ? option.href : "";
    const match = TOHO_TICKET_HREF.exec(href);
    if (!match) throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket option action changed from SelectTicket.setTicket.");
    const [_, groupIndex, seatIndex, providerTicketTypeId, label, renderedPrice] = match;
    if (groupIndex !== "0" || seatIndex !== "0" || !TOHO_TICKET_ID.test(providerTicketTypeId!) || !TOHO_REVIEWED_TICKET_LABEL_SET.has(label!)) {
      throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket option identity is outside the reviewed B2 allowlist.", {
        providerTicketTypeId,
        label,
        groupIndex,
        seatIndex
      });
    }
    const priceYen = parseYenText(renderedPrice!);
    if (priceYen === undefined || text !== `${label}${renderedPrice}`) {
      throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO ticket option label/price no longer matches its rendered action.", { label, text });
    }
    const identity = `${providerTicketTypeId}|${label}`;
    if (identities.has(identity)) throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO rendered duplicate ticket identity.", { identity });
    identities.add(identity);
    ticketTypes.push({
      providerTicketTypeId,
      label: label!,
      priceYen,
      currency: "JPY",
      ...(label === "一般" ? { category: "standard" as const } : {}),
      minQuantity: 1,
      maxQuantity: 1,
      ...ticketHumanReview(label!)
    });
  }
  if (ticketTypes.filter((ticket) => ticket.label === "一般").length !== 1) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 requires one exact reviewed general ticket option.");
  }
  const hTotal = typeof snapshot.hTotal === "string" && /^\d+$/.test(snapshot.hTotal) ? Number(snapshot.hTotal) : NaN;
  const totalText = typeof snapshot.totalText === "string" ? snapshot.totalText : "";
  const totalMatch = /^合計\s*([\d,]+)円$/.exec(totalText);
  const totalYen = totalMatch ? Number(totalMatch[1]!.replace(/,/g, '')) : NaN;
  if (!Number.isSafeInteger(hTotal) || !Number.isSafeInteger(totalYen) || hTotal !== totalYen) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO rendered and hidden ticket totals disagree.", { hTotal, totalText });
  }
  const guests = Array.isArray(snapshot.guestControls) ? snapshot.guestControls as Array<Record<string, unknown>> : [];
  if (guests.length !== 1) throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO guest continuation is missing or ambiguous on J02.");
  const guest = guests[0]!;
  const expectedOnclick = `gotoRej(4, '${siteId}', '', '');`;
  if (guest.label !== "ログインせず次へ" || guest.href !== "javascript:void(0)" || guest.onclick !== expectedOnclick) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO guest continuation identity changed on J02.");
  }
  const extraConditionReasons: string[] = [];
  if (slot.onaVisible === true || Number(slot.onaRadioCount) > 0) extraConditionReasons.push("additional_format_or_special_charge");
  if (slot.campaignVisible === true && String(slot.campaignText || "").trim()) extraConditionReasons.push("provider_campaign_or_payment_condition");
  if (slot.movieTicketVisible === true && String(slot.movieTicketText || "").trim()) extraConditionReasons.push("movie_ticket_manual_step");
  if (slot.limitedTicket === "1") extraConditionReasons.push("payment_method_limited_ticket");
  if (snapshot.formErrorVisible === true && String(snapshot.formErrorText || "").trim()) extraConditionReasons.push("provider_ticket_warning");
  if (typeof snapshot.ajaxActive !== "number" || !Number.isInteger(snapshot.ajaxActive) || snapshot.ajaxActive < 0) {
    throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 cannot prove provider Ajax settlement state.");
  }
  const ajaxActive = snapshot.ajaxActive;
  return {
    provider: "toho",
    siteId,
    seatId: expectedSeatId,
    selectedProviderTicketTypeId: TOHO_TICKET_ID.test(selectTicketValue) ? selectTicketValue : undefined,
    selectionText: typeof slot.selectionText === "string" ? slot.selectionText : "",
    ticketTypes,
    totalYen,
    ajaxActive,
    extraConditionReasons,
    guestContinuation: { label: "ログインせず次へ", href: "javascript:void(0)", onclick: expectedOnclick }
  };
}

function ticketModalTriggerExpression(expectedSeatId: string): string {
  const compactSeat = compactTohoSeatId(expectedSeatId);
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const items = Array.from(document.querySelectorAll('.ticket-item')).filter((item) => normalize(item.innerText).split(' ')[0] === ${JSON.stringify(compactSeat)});
    if (items.length !== 1) return { ok: false, reason: 'ticket_slot_missing' };
    const triggers = Array.from(items[0].querySelectorAll('a[data-modal]')).filter((el) => normalize(el.textContent) === '券種を選択してください');
    if (triggers.length !== 1) return { ok: false, reason: 'modal_trigger_ambiguous' };
    const el = triggers[0];
    if (el.getAttribute('href') !== '#' || el.getAttribute('data-modal') !== 'modal-target-00') return { ok: false, reason: 'modal_trigger_identity' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
    return { ok: rect.width > 0 && rect.height > 0, tagName: el.tagName, text: normalize(el.textContent), href: el.getAttribute('href'), dataModal: el.getAttribute('data-modal'), x, y };
  })()`;
}

function ticketOptionTargetExpression(ticket: CinemaRenderedTicketType): string {
  if (!ticket.providerTicketTypeId || ticket.priceYen === undefined) throw new CheckoutCoreError("INVALID_INTENT", "TOHO B2 exact ticket option lacks provider id or rendered price.");
  const price = formatYen(ticket.priceYen);
  const href = `javascript:SelectTicket.setTicket('0', '0', '${ticket.providerTicketTypeId}', '${ticket.label}', '${price}')`;
  const text = `${ticket.label}${price}`;
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const modal = document.querySelector('[data-modal-content="modal-target-00"]');
    if (!modal || !modal.classList.contains('is-show')) return { ok: false, reason: 'ticket_modal_not_open' };
    const matches = Array.from(modal.querySelectorAll('a')).filter((el) => el.getAttribute('href') === ${JSON.stringify(href)} && normalize(el.textContent) === ${JSON.stringify(text)});
    if (matches.length !== 1) return { ok: false, reason: 'ticket_option_ambiguous' };
    const el = matches[0];
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
    const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
    return { ok: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none', tagName: el.tagName, text: normalize(el.textContent), href: el.getAttribute('href'), x, y };
  })()`;
}

function seatQuery(intent: CinemaCheckoutIntent): SeatAvailabilityQuery {
  return {
    theater: intent.showtime.theater,
    date: intent.showtime.date,
    movie: intent.showtime.movie,
    startTime: intent.showtime.startTime,
    ...(intent.showtime.screen ? { screen: intent.showtime.screen } : {})
  };
}

function selectedIds(map: CinemaSeatMap<"toho">): string[] {
  return map.seats.filter((seat) => seat.state === "selected").map((seat) => seat.id).sort();
}

function expectedAfterSelections(baseline: CinemaSeatMap<"toho">, selected: ReadonlySet<string>): CinemaSeatMap<"toho"> {
  return {
    ...baseline,
    seats: baseline.seats.map((seat) => selected.has(seat.id)
      ? { ...seat, state: "selected" as const, unavailableReason: undefined }
      : { ...seat })
  };
}

function assertOnlyExpectedSelectionChanged(
  baseline: CinemaSeatMap<"toho">,
  current: CinemaSeatMap<"toho">,
  expectedSelected: readonly string[]
): void {
  const expectedSet = new Set(expectedSelected);
  const observedSelected = selectedIds(current);
  const orderedExpected = [...expectedSelected].sort();
  if (observedSelected.length !== orderedExpected.length || observedSelected.some((id, index) => id !== orderedExpected[index])) {
    throw new CheckoutCoreError(
      "STALE_CONTEXT",
      "TOHO rendered selected-seat set does not exactly match the intended mutation prefix.",
      { expectedSelected: orderedExpected, observedSelected }
    );
  }
  const comparison = compareCinemaSeatObservations(expectedAfterSelections(baseline, expectedSet), current);
  if (!comparison.stable) {
    throw new CheckoutCoreError(
      "STALE_CONTEXT",
      "TOHO seat context, layout, or unrelated inventory changed during exact seat selection.",
      { change: comparison.change, expected: comparison.first, observed: comparison.second }
    );
  }
}

function assertOrdinaryIntendedSeats(map: CinemaSeatMap<"toho">, seatIds: readonly string[]): void {
  const byId = new Map(map.seats.map((seat) => [seat.id, seat]));
  for (const seatId of seatIds) {
    const seat = byId.get(seatId);
    if (!seat || seat.state !== "available") {
      throw new CheckoutCoreError("SEAT_UNAVAILABLE", "TOHO exact intended seat is no longer confirmed available.", {
        seatId,
        state: seat?.state ?? "missing"
      });
    }
    if (seat.attributes.length > 0) {
      throw new CheckoutCoreError(
        "AMBIGUOUS_RENDERED_STATE",
        "TOHO special/accessibility seats are not enabled by the first Phase 4 adapter without a separate explicit review.",
        { seatId, attributes: seat.attributes }
      );
    }
  }
}

/**
 * Internal TOHO Phase 4 adapter. It is intentionally not wired to the MCP tool registry
 * or provider capability matrix yet. It may select only exact ordinary seats. If TOHO
 * exposes the intermediate rendered `確認する` step, the adapter stops because that
 * candidate hold boundary is not reviewed. It never clicks seat-confirmation or consent controls.
 */
export class TohoCheckoutAdapter {
  private readonly seatReader: CinemaSeatReadAdapter<"toho", TohoTheater, TohoShowtime>;

  constructor(
    private readonly runtime: TohoCheckoutRuntime,
    seatReader?: CinemaSeatReadAdapter<"toho", TohoTheater, TohoShowtime>
  ) {
    this.seatReader = seatReader ?? new TohoReadAdapter(runtime as CinemaBrowserRuntime);
  }

  async readTicketStageAfterGate1(rawIntent: CinemaCheckoutIntent): Promise<TohoNormalizedTicketStage> {
    const intent = parseCinemaCheckoutIntent(rawIntent);
    if (intent.provider !== "toho" || intent.seatIds.length !== 1) {
      throw new CheckoutCoreError("INVALID_INTENT", "TOHO B2 initial ticket-stage slice supports exactly one intended seat.");
    }
    const semantic = await this.runtime.evaluateSemanticState<TohoTicketStageSnapshot>("toho", TOHO_TICKET_STAGE_EXPRESSION);
    const stage = normalizeTohoTicketStageSnapshot(semantic.value, intent.seatIds[0]!);
    let observed: URL;
    try { observed = new URL(semantic.url); } catch {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO B2 semantic read returned an invalid provider URL.");
    }
    if (
      observed.protocol !== "https:" || observed.hostname !== "hlo.tohotheater.jp" ||
      observed.pathname !== `/net/ticket/${stage.siteId}/TNPI2010J02.do` || observed.search || observed.hash
    ) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO B2 semantic read left the reviewed ticket-stage route.");
    }
    return stage;
  }

  async selectExactTicketAfterGate1(rawIntent: CinemaCheckoutIntent): Promise<TohoTicketSelectionResult> {
    const intent = parseCinemaCheckoutIntent(rawIntent);
    if (intent.provider !== "toho" || intent.seatIds.length !== 1 || intent.ticketChoices.length !== 1 || intent.ticketChoices[0]!.quantity !== 1) {
      throw new CheckoutCoreError("INVALID_INTENT", "TOHO B2 initial vertical slice requires one seat and one exact ticket choice with quantity 1.");
    }
    const seatId = intent.seatIds[0]!;
    const initial = await this.readTicketStageAfterGate1(intent);
    if (initial.selectedProviderTicketTypeId !== undefined || initial.totalYen !== 0) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO B2 must start before any ticket type has already been selected.");
    }
    const resolved = resolveCheckoutTicketChoices(intent, initial.ticketTypes);
    if (resolved.selections.length !== 1) throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 did not resolve one exact intended ticket.");
    if (resolved.humanReviewReasons.length > 0) {
      throw new BrowserRuntimeError(
        "HUMAN_ACTION_REQUIRED",
        "TOHO rendered an eligibility- or condition-bound ticket choice. Review the provider qualification directly; B2 will not infer eligibility or select it automatically.",
        { reasons: resolved.humanReviewReasons, label: resolved.selections[0]!.ticketType.label }
      );
    }
    const selected = resolved.selections[0]!;
    const ticket = selected.ticketType;
    if (ticket.label !== "一般" || ticket.humanReviewRequired === true || !ticket.providerTicketTypeId || ticket.priceYen === undefined) {
      throw new BrowserRuntimeError("HUMAN_ACTION_REQUIRED", "TOHO B2 only auto-selects the exact reviewed unconditioned `一般` ticket in the initial slice.");
    }

    await this.runtime.consumeTohoGate1TicketProof({ seatId, intentDigest: checkoutIntentDigest(intent) });

    const trigger = await this.runtime.evaluateSemanticState<{ ok?: unknown; tagName?: unknown; text?: unknown; href?: unknown; dataModal?: unknown; x?: unknown; y?: unknown }>(
      "toho",
      ticketModalTriggerExpression(seatId)
    );
    if (
      trigger.value.ok !== true || trigger.value.tagName !== "A" || trigger.value.text !== "券種を選択してください" ||
      trigger.value.href !== "#" || trigger.value.dataModal !== "modal-target-00" ||
      typeof trigger.value.x !== "number" || typeof trigger.value.y !== "number"
    ) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO B2 ticket modal trigger changed before reviewed pointer dispatch.");
    }
    await this.runtime.clickReviewedElementPoint(
      { x: trigger.value.x, y: trigger.value.y },
      "toho",
      { tagName: "A", text: "券種を選択してください", href: "#", dataModal: "modal-target-00" }
    );

    const option = await this.runtime.evaluateSemanticState<{ ok?: unknown; tagName?: unknown; text?: unknown; href?: unknown; x?: unknown; y?: unknown }>(
      "toho",
      ticketOptionTargetExpression(ticket)
    );
    const priceText = formatYen(ticket.priceYen);
    const expectedText = `${ticket.label}${priceText}`;
    const expectedHref = `javascript:SelectTicket.setTicket('0', '0', '${ticket.providerTicketTypeId}', '${ticket.label}', '${priceText}')`;
    if (
      option.value.ok !== true || option.value.tagName !== "A" || option.value.text !== expectedText || option.value.href !== expectedHref ||
      typeof option.value.x !== "number" || typeof option.value.y !== "number"
    ) {
      throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO B2 exact intended ticket option changed before reviewed pointer dispatch.");
    }
    await this.runtime.clickReviewedElementPoint(
      { x: option.value.x, y: option.value.y },
      "toho",
      { tagName: "A", text: expectedText, href: expectedHref }
    );

    let after: TohoNormalizedTicketStage | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const observed = await this.readTicketStageAfterGate1(intent);
      if (observed.ajaxActive === 0 && observed.selectedProviderTicketTypeId === ticket.providerTicketTypeId) {
        after = observed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!after || after.selectedProviderTicketTypeId !== ticket.providerTicketTypeId || after.totalYen !== ticket.priceYen) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO B2 selected ticket did not settle to the exact provider id and rendered total.", {
        providerTicketTypeId: ticket.providerTicketTypeId,
        expectedTotalYen: ticket.priceYen,
        observedTotalYen: after?.totalYen
      });
    }
    if (!after.selectionText.includes(ticket.label) || !after.selectionText.includes(priceText)) {
      throw new CheckoutCoreError("AMBIGUOUS_RENDERED_STATE", "TOHO B2 rendered selection summary does not contain the exact ticket label and price.");
    }
    if (after.extraConditionReasons.length > 0) {
      throw new BrowserRuntimeError(
        "HUMAN_ACTION_REQUIRED",
        "TOHO returned additional ticket conditions after selection. B2 stops before guest/purchaser continuation and does not interpret or satisfy those conditions automatically.",
        { reasons: after.extraConditionReasons, label: ticket.label }
      );
    }
    return {
      provider: "toho",
      stage: "member_or_guest",
      seatId,
      selected,
      totalYen: after.totalYen,
      guestContinuationReady: true,
      neverReplay: true
    };
  }

  async selectExactSeatsToConsentBoundary(rawIntent: CinemaCheckoutIntent): Promise<never> {
    const intent = parseCinemaCheckoutIntent(rawIntent);
    if (intent.provider !== "toho") {
      throw new CheckoutCoreError("INVALID_INTENT", "TOHO checkout adapter received another provider intent.");
    }

    const query = seatQuery(intent);
    const first = await this.seatReader.getSeatAvailability(query);
    const second = await this.seatReader.getSeatAvailability(query);
    const plan = validateCheckoutSeatIntent(intent, first, second);
    const baseline = second.seatMap;
    assertOrdinaryIntendedSeats(baseline, plan.seatIds);

    const layout = await this.runtime.evaluateSemanticState<TohoCheckoutLayoutSnapshot>(
      "toho",
      TOHO_CHECKOUT_LAYOUT_EXPRESSION
    );
    if (layout.url !== baseline.sourceUrl) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO seat page changed before checkout layout validation.");
    }
    const width = typeof layout.value.width === "number" ? layout.value.width : NaN;
    const height = typeof layout.value.height === "number" ? layout.value.height : NaN;
    if (
      layout.value.orientationBlocked === true ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      (width < TOHO_MIN_DESKTOP_MUTATION_WIDTH && width > height)
    ) {
      throw new BrowserRuntimeError(
        "UI_STATE_CHANGED",
        "TOHO checkout mutation requires a supported rendered viewport before any seat activation.",
        { reason: "unsupported_checkout_viewport", width: Number.isFinite(width) ? width : undefined, height: Number.isFinite(height) ? height : undefined }
      );
    }

    const selected: string[] = [];
    let finalSelectedMap = baseline;
    for (const seatId of plan.seatIds) {
      const beforeSemantic = await this.runtime.evaluateSemanticState<TohoSeatSnapshot>("toho", TOHO_SEAT_MAP_EXPRESSION);
      const before = normalizeTohoSeatSnapshot(
        beforeSemantic.value,
        beforeSemantic.url,
        second.theater,
        second.showtime,
        new Date().toISOString(),
        { allowSelected: true }
      );
      assertOnlyExpectedSelectionChanged(baseline, before, selected);

      const remaining = plan.seatIds.filter((id) => !selected.includes(id));
      assertOrdinaryIntendedSeats(before, remaining);
      const targetSemantic = await this.runtime.evaluateSemanticState<TohoSeatClickTarget>(
        "toho",
        exactSeatClickTargetExpression(seatId)
      );
      if (targetSemantic.url !== baseline.sourceUrl) {
        throw new CheckoutCoreError("STALE_CONTEXT", "TOHO seat page changed before exact seat activation.", {
          expectedUrl: baseline.sourceUrl,
          observedUrl: targetSemantic.url
        });
      }
      const target = targetSemantic.value;
      if (
        target.ok !== true || target.id !== seatId || target.tagName !== "IMG" || target.src !== "seat_1.gif" ||
        target.alt !== `${seatId} 空席(選択可)` || typeof target.x !== "number" || typeof target.y !== "number"
      ) {
        throw new CheckoutCoreError("STALE_CONTEXT", "TOHO exact intended seat changed before activation.", {
          seatId,
          reason: target.reason
        });
      }

      await this.runtime.clickReviewedElementPoint(
        { x: target.x, y: target.y },
        "toho",
        { id: seatId, tagName: "IMG" }
      );
      selected.push(seatId);

      const afterSemantic = await this.runtime.evaluateSemanticState<TohoSeatSnapshot>("toho", TOHO_SEAT_MAP_EXPRESSION);
      const after = normalizeTohoSeatSnapshot(
        afterSemantic.value,
        afterSemantic.url,
        second.theater,
        second.showtime,
        new Date().toISOString(),
        { allowSelected: true }
      );
      assertOnlyExpectedSelectionChanged(baseline, after, selected);
      finalSelectedMap = after;
    }

    const boundary = await this.runtime.evaluateSemanticState<TohoPostSelectionBoundarySnapshot>(
      "toho",
      TOHO_POST_SELECTION_BOUNDARY_EXPRESSION
    );
    if (boundary.url !== baseline.sourceUrl) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO left the reviewed seat page after exact seat selection.");
    }
    if (boundary.value.sensitiveFields !== 0) {
      throw new BrowserRuntimeError(
        "UI_STATE_CHANGED",
        "TOHO exposed a sensitive field before the reviewed checkout continuation boundary.",
        { sensitiveFields: boundary.value.sensitiveFields }
      );
    }
    if (boundary.value.orientationBlocked === true) {
      throw new BrowserRuntimeError(
        "UI_STATE_CHANGED",
        "TOHO blocked the post-selection layout because the current browser orientation is unsupported.",
        { reason: "unsupported_landscape_layout" }
      );
    }
    if (boundary.value.confirm !== null && boundary.value.confirm !== undefined) {
      const confirm = boundary.value.confirm as { id?: unknown; tagName?: unknown; className?: unknown; label?: unknown; interactive?: unknown };
      if (
        confirm.id !== "fooder_menu_conf_bt" ||
        confirm.tagName !== "DIV" ||
        confirm.className !== "seat-action-button" ||
        confirm.label !== "確認する"
      ) {
        throw new BrowserRuntimeError("UI_STATE_CHANGED", "TOHO seat-confirmation control no longer matches the reviewed public UI identity.");
      }
      throw new BrowserRuntimeError(
        "UNREVIEWED_INTERACTION",
        "TOHO requires a separate rendered seat-confirmation step before legal consent; its hold semantics are not yet approved for automation.",
        { controlLabel: "確認する", interactive: confirm.interactive === true }
      );
    }
    if (boundary.value.exactConsentNextControls !== 1) {
      throw new BrowserRuntimeError(
        "UI_STATE_CHANGED",
        "TOHO did not expose one reviewed post-confirm legal-consent continuation.",
        {
          exactConsentNextControls: boundary.value.exactConsentNextControls,
          visibleLabels: boundary.value.visibleLabels
        }
      );
    }

    const browserContext = await this.runtime.getReviewedBrowserContext("toho");
    const baselineUrl = new URL(baseline.sourceUrl);
    if (browserContext.host !== baselineUrl.host || browserContext.pathname !== baselineUrl.pathname) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO browser target changed before the reviewed Human consent handoff.");
    }

    const binding = this.runtime.createCheckoutContinuation({
      provider: "toho",
      boundary: "toho_terms_consent_next",
      intent,
      theaterId: second.theater.id,
      showtimeIdentity: finalSelectedMap.showtimeIdentity,
      selectedSeatIds: selected,
      preHumanFingerprints: currentCheckoutSeatFingerprints(finalSelectedMap),
      sourceSurface: { host: browserContext.host, pathname: browserContext.pathname },
      browserTargetId: browserContext.targetId
    });

    return this.runtime.requireReviewedHumanIntervention({
      reason: "consent",
      action: {
        kind: "reviewed_checkout_boundary",
        provider: "toho",
        boundary: "toho_terms_consent_next",
        continuationDigest: binding.continuationDigest
      },
      message: [
        `TOHO rendered the reviewed ${TOHO_CONSENT_NEXT_LABEL} boundary for the exact selected seats.`,
        "Review the terms directly in Chrome and operate that exact control yourself only if you agree.",
        "Do not change seats, enter credentials/OTP/PII/payment data through MCP, or proceed to a final purchase.",
        "After the manual consent transition, choose Continue so the agent can verify the new rendered stage without replaying seat selection."
      ].join(" ")
    });
  }
}
