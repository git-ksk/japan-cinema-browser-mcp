import type { CinemaProviderId } from "./providers.js";

export type ShowtimeLanguage = "subtitled" | "dubbed";

/**
 * `unknown` means no reviewed explicit availability signal was observed. It must never be
 * interpreted as seats being available. `unavailable` means the showtime exists but the
 * provider explicitly exposes sales as unavailable/outside its active sales window.
 */
export type ShowtimeAvailability = "unknown" | "limited" | "sold_out" | "unavailable";

/** Canonical output vocabulary. Provider-specific DOM wording remains inside each adapter. */
export const SHOWTIME_FORMATS = [
  "2D",
  "3D",
  "IMAX",
  "IMAX LASER",
  "4DX",
  "ULTRA 4DX",
  "MX4D",
  "SCREENX",
  "DOLBY ATMOS",
  "DOLBY CINEMA",
  "DTS:X",
  "TCX",
  "PREMIUM THEATER",
  "GO-ON",
  "THX",
  "ULTIRA",
  "D-BOX",
  "VSOUND",
  "VIVE AUDIO",
  "SAION",
  "SAION SR EDITION"
] as const;

export type ShowtimeFormat = (typeof SHOWTIME_FORMATS)[number];

export interface CinemaTheater<P extends CinemaProviderId = CinemaProviderId> {
  provider: P;
  id: string;
  name: string;
  /** Public UI surface from which this theater identity was observed. */
  sourceUrl: string;
}

export interface CinemaShowtime<P extends CinemaProviderId = CinemaProviderId> {
  provider: P;
  theaterId: string;
  theater: string;
  date: string;
  /** Provider-visible display title; cross-provider title rewriting is intentionally out of scope. */
  movie: string;
  startTime: string;
  endTime?: string;
  formats: ShowtimeFormat[];
  language?: ShowtimeLanguage;
  screen?: string;
  availability: ShowtimeAvailability;
  /** Reviewed public schedule page from which this showtime fact was observed. */
  sourceUrl: string;
}

export interface TheaterListResult<
  P extends CinemaProviderId = CinemaProviderId,
  TTheater extends CinemaTheater<P> = CinemaTheater<P>
> {
  provider: P;
  /** Reviewed public theater-list surface used for this result. */
  sourceUrl: string;
  theaters: TTheater[];
}

export interface ShowtimeResult<
  P extends CinemaProviderId = CinemaProviderId,
  TTheater extends CinemaTheater<P> = CinemaTheater<P>,
  TShowtime extends CinemaShowtime<P> = CinemaShowtime<P>
> {
  provider: P;
  theater: TTheater;
  date: string;
  /** Date-level provider fact. This must not change after applying an optional movie filter. */
  dateAvailable: boolean;
  /** Explicitly observed schedule dates for the resolved theater/current public schedule surface. */
  availableDates: string[];
  /** Reviewed public schedule surface matching the returned date/theater result. */
  sourceUrl: string;
  showtimes: TShowtime[];
}

export interface ShowtimeQuery {
  theater: string;
  date?: string;
  movie?: string;
}

export interface CinemaReadAdapter<
  P extends CinemaProviderId = CinemaProviderId,
  TTheater extends CinemaTheater<P> = CinemaTheater<P>,
  TShowtime extends CinemaShowtime<P> = CinemaShowtime<P>
> {
  listTheaters(query?: string): Promise<TheaterListResult<P, TTheater>>;
  getShowtimes(input: ShowtimeQuery): Promise<ShowtimeResult<P, TTheater, TShowtime>>;
}

/**
 * Live seat availability is independent from seat type. A premium, wheelchair,
 * pair, or other special seat can still be available or unavailable.
 */
export type CinemaSeatState = "available" | "unavailable" | "selected" | "unknown";

/** Only populate a reason when the rendered provider UI actually distinguishes it. */
export type CinemaSeatUnavailableReason = "sold" | "blocked" | "not_for_sale" | "unknown";

export type CinemaSeatAttribute =
  | "wheelchair"
  | "companion"
  | "premium"
  | "executive"
  | "pair"
  | "d-box"
  | "gold-class"
  | `provider:${string}`;

/** A boundary is meaningful only when it was observed from the rendered layout. */
export type CinemaSeatBoundary = "aisle" | "gap";

export interface CinemaSeat {
  /** Stable identity as exposed by the current provider UI, for example `H-012`. */
  id: string;
  row?: string;
  number?: string;
  state: CinemaSeatState;
  unavailableReason?: CinemaSeatUnavailableReason;
  attributes: CinemaSeatAttribute[];
  /** Zero-based normalized row order supplied by the provider adapter when observable. */
  rowIndex?: number;
  /** Zero-based layout slot supplied by the provider adapter. Gaps should consume slots. */
  columnIndex?: number;
  /** Optional rendered-layout coordinates; any consistent provider-local coordinate scale is valid. */
  x?: number;
  y?: number;
  leftBoundary?: CinemaSeatBoundary;
  rightBoundary?: CinemaSeatBoundary;
  /** Provider-declared pair/group identity. Recommendation must not split an observed group by default. */
  groupId?: string;
}

export interface CinemaSeatMap<P extends CinemaProviderId = CinemaProviderId> {
  provider: P;
  theaterId: string;
  theater?: string;
  screen?: string;
  /** Stable identity tying this map to exactly one rendered showtime context. */
  showtimeIdentity: string;
  seats: CinemaSeat[];
  /** Screen/front edge in the rendered coordinate system, when observable. */
  screenEdge?: "top" | "bottom" | "left" | "right";
  /** ISO timestamp for this observation. */
  observedAt: string;
  /** Reviewed public seat-map URL from which these facts were observed. */
  sourceUrl: string;
}


export interface SeatAvailabilityQuery {
  theater: string;
  /** Required because seat availability is time-sensitive and must bind to one public schedule date. */
  date: string;
  movie: string;
  /** Provider-visible 24-hour start time, for example `21:10`. */
  startTime: string;
  /** Optional caller disambiguator; the adapter still requires one observed screen identity. */
  screen?: string;
}

export interface SeatAvailabilityResult<
  P extends CinemaProviderId = CinemaProviderId,
  TTheater extends CinemaTheater<P> = CinemaTheater<P>,
  TShowtime extends CinemaShowtime<P> = CinemaShowtime<P>
> {
  provider: P;
  theater: TTheater;
  showtime: TShowtime;
  seatMap: CinemaSeatMap<P>;
}

export interface CinemaSeatReadAdapter<
  P extends CinemaProviderId = CinemaProviderId,
  TTheater extends CinemaTheater<P> = CinemaTheater<P>,
  TShowtime extends CinemaShowtime<P> = CinemaShowtime<P>
> {
  getSeatAvailability(input: SeatAvailabilityQuery): Promise<SeatAvailabilityResult<P, TTheater, TShowtime>>;
}
