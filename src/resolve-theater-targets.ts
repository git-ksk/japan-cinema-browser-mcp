import { BrowserRuntimeError } from "./browser/runtime.js";
import type { CinemaReadAdapter, CinemaTheater } from "./cinema.js";
import type { FindShowtimesTarget } from "./find-showtimes.js";
import { ProviderPolicyError, assertOfficialUrl, type CinemaProviderId } from "./providers.js";

export interface ExternalPlaceCandidate {
  index?: number;
  label: string;
}

export interface ResolveTheaterTargetsQuery {
  candidates: ExternalPlaceCandidate[];
  sourceTruncated?: boolean;
  limit?: number;
}

export type TheaterTargetResolutionReason =
  | "UNSUPPORTED_PROVIDER_LABEL"
  | "NO_THEATER_MATCH"
  | "AMBIGUOUS_THEATER_MATCH"
  | "DUPLICATE_TARGET"
  | "TARGET_LIMIT_REACHED"
  | "PROVIDER_FAILURE"
  | "CONTRACT_VIOLATION";

export interface ResolvedTheaterTarget {
  candidate: ExternalPlaceCandidate;
  target: FindShowtimesTarget;
  theater: CinemaTheater;
}

export interface UnresolvedTheaterTarget {
  candidate: ExternalPlaceCandidate;
  provider?: CinemaProviderId;
  reason: TheaterTargetResolutionReason;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface ResolveTheaterTargetsResult {
  source: "external_place_candidates";
  sourceTruncated: boolean;
  targetLimit: number;
  limitReached: boolean;
  targets: FindShowtimesTarget[];
  resolved: ResolvedTheaterTarget[];
  unresolved: UnresolvedTheaterTarget[];
}

export type CinemaReadAdapterResolver = (provider: CinemaProviderId) => CinemaReadAdapter;

function compactLabel(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function providerFromExternalPlaceLabel(value: string): CinemaProviderId | undefined {
  const label = compactLabel(value);
  if (/^TOHOシネマズ(?:\s|$)/i.test(label)) return "toho";
  if (/^イオンシネマ(?:\s|$)/i.test(label)) return "aeon";
  if (/^(?:109|１０９)シネマズ/i.test(label) || label === "ムービル") return "109";
  return undefined;
}

function contractViolation(provider: CinemaProviderId, result: { provider: CinemaProviderId; sourceUrl: string; theaters: CinemaTheater[] }): string | undefined {
  if (result.provider !== provider) return "theater-list provider identity mismatch";
  try {
    assertOfficialUrl(result.sourceUrl, provider);
  } catch {
    return "theater-list provenance is outside the reviewed provider domain";
  }
  for (const theater of result.theaters) {
    if (theater.provider !== provider || !theater.id || !theater.name) {
      return "theater identity does not match the target provider contract";
    }
    try {
      assertOfficialUrl(theater.sourceUrl, provider);
    } catch {
      return "theater provenance is outside the reviewed provider domain";
    }
  }
  return undefined;
}

function providerFailure(candidate: ExternalPlaceCandidate, provider: CinemaProviderId, error: unknown): UnresolvedTheaterTarget {
  if (error instanceof BrowserRuntimeError) {
    return {
      candidate,
      provider,
      reason: "PROVIDER_FAILURE",
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      }
    };
  }
  if (error instanceof ProviderPolicyError) {
    return {
      candidate,
      provider,
      reason: "PROVIDER_FAILURE",
      error: { code: error.code, message: error.message }
    };
  }
  console.error("[japan-cinema-browser-mcp] unexpected theater target resolution error", provider, error);
  return {
    candidate,
    provider,
    reason: "PROVIDER_FAILURE",
    error: {
      code: "INTERNAL_ERROR",
      message: "The provider theater resolution failed unexpectedly. Check the local MCP server logs."
    }
  };
}

export async function resolveTheaterTargets(
  input: ResolveTheaterTargetsQuery,
  adapterFor: CinemaReadAdapterResolver
): Promise<ResolveTheaterTargetsResult> {
  if (input.candidates.length < 1 || input.candidates.length > 8) {
    throw new Error("resolve_theater_targets requires between 1 and 8 bounded external place candidates");
  }
  const targetLimit = input.limit ?? 3;
  if (!Number.isInteger(targetLimit) || targetLimit < 1 || targetLimit > 3) {
    throw new Error("resolve_theater_targets limit must be an integer between 1 and 3");
  }

  const targets: FindShowtimesTarget[] = [];
  const resolved: ResolvedTheaterTarget[] = [];
  const unresolved: UnresolvedTheaterTarget[] = [];
  const resolvedIds = new Set<string>();
  let limitReached = false;

  // The candidates are already area-ranked by an external resolver such as maps-browser-mcp.
  // Preserve that order and use at most the first three uniquely verified cinema targets.
  // Provider reads remain sequential because all adapters share one Chrome/CDP session.
  for (const rawCandidate of input.candidates) {
    const candidate: ExternalPlaceCandidate = {
      ...(rawCandidate.index !== undefined ? { index: rawCandidate.index } : {}),
      label: compactLabel(rawCandidate.label)
    };
    if (!candidate.label) {
      unresolved.push({ candidate, reason: "UNSUPPORTED_PROVIDER_LABEL" });
      continue;
    }

    if (targets.length >= targetLimit) {
      limitReached = true;
      unresolved.push({ candidate, reason: "TARGET_LIMIT_REACHED" });
      continue;
    }

    const provider = providerFromExternalPlaceLabel(candidate.label);
    if (!provider) {
      unresolved.push({ candidate, reason: "UNSUPPORTED_PROVIDER_LABEL" });
      continue;
    }

    try {
      const result = await adapterFor(provider).listTheaters(candidate.label);
      const violation = contractViolation(provider, result);
      if (violation) {
        unresolved.push({
          candidate,
          provider,
          reason: "CONTRACT_VIOLATION",
          error: {
            code: "CONTRACT_VIOLATION",
            message: `Provider theater result violated the common cinema contract: ${violation}`
          }
        });
        continue;
      }

      if (result.theaters.length === 0) {
        unresolved.push({ candidate, provider, reason: "NO_THEATER_MATCH" });
        continue;
      }
      if (result.theaters.length !== 1) {
        unresolved.push({
          candidate,
          provider,
          reason: "AMBIGUOUS_THEATER_MATCH",
          error: {
            code: "AMBIGUOUS_THEATER_MATCH",
            message: "The external place label matched more than one reviewed provider theater.",
            details: { candidates: result.theaters.slice(0, 8).map((theater) => theater.name) }
          }
        });
        continue;
      }

      const theater = result.theaters[0]!;
      const identity = `${provider}:${theater.id}`;
      if (resolvedIds.has(identity)) {
        unresolved.push({ candidate, provider, reason: "DUPLICATE_TARGET" });
        continue;
      }
      resolvedIds.add(identity);

      const target: FindShowtimesTarget = { provider, theater: theater.name };
      targets.push(target);
      resolved.push({ candidate, target, theater });
    } catch (error) {
      unresolved.push(providerFailure(candidate, provider, error));
    }
  }

  return {
    source: "external_place_candidates",
    sourceTruncated: input.sourceTruncated === true,
    targetLimit,
    limitReached,
    targets,
    resolved,
    unresolved
  };
}
