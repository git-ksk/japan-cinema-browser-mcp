import { BrowserRuntimeError, type CinemaBrowserRuntime } from "../../browser/runtime.js";
import type { CinemaSeatMap, CinemaSeatReadAdapter, SeatAvailabilityQuery } from "../../cinema.js";
import {
  CheckoutCoreError,
  parseCinemaCheckoutIntent,
  validateCheckoutSeatIntent,
  type CinemaCheckoutFreshnessBinding,
  type CinemaCheckoutIntent
} from "../../checkout.js";
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

interface TohoCheckoutRuntime {
  evaluateSemanticState<T>(expectedProvider: "toho", expression: string): Promise<{ url: string; value: T }>;
  clickReviewedElementPoint(
    point: { x: number; y: number },
    expectedProvider: "toho",
    expectedElement: { id: string; tagName: string }
  ): Promise<Record<string, unknown>>;
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

interface TohoConsentBoundarySnapshot {
  exactConsentNextControls?: unknown;
  sensitiveFields?: unknown;
  visibleLabels?: unknown;
}

export interface TohoSeatSelectionPreparation {
  status: "human_action_required";
  provider: "toho";
  reason: "consent";
  selectedSeatIds: string[];
  consentControlLabel: typeof TOHO_CONSENT_NEXT_LABEL;
  sourceUrl: string;
  freshness: CinemaCheckoutFreshnessBinding;
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

const TOHO_CONSENT_BOUNDARY_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
  };
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
    exactConsentNextControls: controls.filter((label) => label === '利用規約に同意して次へ').length,
    sensitiveFields: sensitiveFields.length,
    visibleLabels: controls.filter((label) => /利用規約|次へ/.test(label)).slice(0, 8)
  };
})()`;

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
 * or provider capability matrix yet. It may select only exact ordinary seats and stops
 * at the rendered legal-consent boundary; it never clicks the consent/next control.
 */
export class TohoCheckoutAdapter {
  private readonly seatReader: CinemaSeatReadAdapter<"toho", TohoTheater, TohoShowtime>;

  constructor(
    private readonly runtime: TohoCheckoutRuntime,
    seatReader?: CinemaSeatReadAdapter<"toho", TohoTheater, TohoShowtime>
  ) {
    this.seatReader = seatReader ?? new TohoReadAdapter(runtime as CinemaBrowserRuntime);
  }

  async selectExactSeatsToConsentBoundary(rawIntent: CinemaCheckoutIntent): Promise<TohoSeatSelectionPreparation> {
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

    const selected: string[] = [];
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
    }

    const boundary = await this.runtime.evaluateSemanticState<TohoConsentBoundarySnapshot>(
      "toho",
      TOHO_CONSENT_BOUNDARY_EXPRESSION
    );
    if (boundary.url !== baseline.sourceUrl) {
      throw new CheckoutCoreError("STALE_CONTEXT", "TOHO left the reviewed seat page before the Human consent boundary.");
    }
    if (boundary.value.sensitiveFields !== 0 || boundary.value.exactConsentNextControls !== 1) {
      throw new BrowserRuntimeError(
        "UI_STATE_CHANGED",
        "TOHO did not expose exactly one reviewed legal-consent continuation after seat selection.",
        {
          exactConsentNextControls: boundary.value.exactConsentNextControls,
          sensitiveFields: boundary.value.sensitiveFields,
          visibleLabels: boundary.value.visibleLabels
        }
      );
    }

    return {
      status: "human_action_required",
      provider: "toho",
      reason: "consent",
      selectedSeatIds: [...selected],
      consentControlLabel: TOHO_CONSENT_NEXT_LABEL,
      sourceUrl: baseline.sourceUrl,
      freshness: plan.freshness
    };
  }
}
