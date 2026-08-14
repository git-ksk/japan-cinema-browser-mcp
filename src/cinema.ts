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
