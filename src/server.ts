import { randomBytes } from "node:crypto";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { ChromeProcess } from "./browser/chrome-process.js";
import { BrowserRuntimeError, CinemaBrowserRuntime, type CinemaIntervention } from "./browser/runtime.js";
import { runTimedBrowserOperation } from "./browser/operation-timeout.js";
import {
  ExecutionHandoffError,
  claimHandoffOwner,
  createHandoffOwner,
  handoffOwnerMatches,
  type HandoffOwner,
  type HandoffResumeStrategy
} from "mcp-execution-handoff/core";
import {
  HANDOFF_INPUT_KEY,
  HANDOFF_STATE_TTL_SECONDS,
  HUMAN_INTERVENTION_SCHEMA,
  createHandoffRequestState,
  handoffStateMatchesInvocation,
  type HandoffRequestState
} from "mcp-execution-handoff/mcp";
import { createCinemaExecutionAdapter } from "./cinema-execution-adapter.js";
import { OperationQueue } from "./operation-queue.js";
import { CINEMA_HANDOFF_POLICY } from "./handoff-policy.js";
import { SHOWTIME_FORMATS, type CinemaReadAdapter } from "./cinema.js";
import { findShowtimes } from "./find-showtimes.js";
import { resolveTheaterTargets } from "./resolve-theater-targets.js";
import {
  CINEMA_PROVIDERS,
  ProviderPolicyError,
  assertProviderCapability,
  isFinalPurchaseLabel,
  type CinemaProviderId
} from "./providers.js";
import { Cinemas109ReadAdapter } from "./providers/109/adapter.js";
import { AeonReadAdapter } from "./providers/aeon/adapter.js";
import { TohoReadAdapter } from "./providers/toho/adapter.js";
import { PurchaseGate, PurchaseGateError, type PurchaseSummary } from "./purchase-gate.js";
import { UsageDeniedError } from "mcp-usage-control";
import { currentRequestPrincipal, principalBinding } from "./request-principal.js";
import { CinemaUsageRuntime } from "./usage.js";

const SERVER_VERSION = "0.1.0";
export const config = loadConfig();
const chrome = new ChromeProcess(config.browser);
const runtime = new CinemaBrowserRuntime(chrome, config.policy.maxReadChars);
const executionAdapter = createCinemaExecutionAdapter(runtime);
const operationQueue = new OperationQueue();
const tohoReadAdapter = new TohoReadAdapter(runtime);
const aeonReadAdapter = new AeonReadAdapter(runtime);
const cinemas109ReadAdapter = new Cinemas109ReadAdapter(runtime);
const purchaseGate = new PurchaseGate(config.policy.confirmationTtlMs);
const usageRuntime = config.usage ? new CinemaUsageRuntime(config.usage) : undefined;
const handoffStateCodec = createRequestStateCodec<HandoffRequestState>({
  key: randomBytes(32).toString("base64url"),
  ttlSeconds: HANDOFF_STATE_TTL_SECONDS
});
const handoffOwners = new Map<string, HandoffOwner>();
const LOCAL_PRINCIPAL_BINDING = "local-stdio";

const providerSchema = z.enum(["toho", "aeon", "109"]);
const shortText = z.string().trim().min(1).max(240);
const isoDate = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM");
const handoffDecisionSchema = z.object({ decision: z.enum(["continue", "cancel"]) });

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const usageDenied = error instanceof UsageDeniedError;
  const known =
    error instanceof BrowserRuntimeError ||
    error instanceof ProviderPolicyError ||
    error instanceof PurchaseGateError ||
    error instanceof ExecutionHandoffError ||
    usageDenied;
  if (!known) console.error("[japan-cinema-browser-mcp] unexpected tool error", error);
  const code = usageDenied ? "USAGE_LIMIT_REACHED" : known ? (error as { code: string }).code : "INTERNAL_ERROR";
  const message = usageDenied
    ? "The daily MCP usage limit has been reached for this authenticated principal."
    : known
      ? error.message
      : "The operation failed unexpectedly. Check the local MCP server logs.";
  const details = error instanceof BrowserRuntimeError ? error.details : undefined;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message, details }) }],
    isError: true
  };
}

async function safe<T>(task: () => Promise<T> | T): Promise<CallToolResult> {
  try {
    return jsonResult(await task());
  } catch (error) {
    return errorResult(error);
  }
}

function currentPrincipalBinding(): string {
  const principal = currentRequestPrincipal();
  return principal ? principalBinding(principal) : LOCAL_PRINCIPAL_BINDING;
}

function ownerFor(toolName: string, args: unknown, resumeStrategy: HandoffResumeStrategy): HandoffOwner {
  return createHandoffOwner(currentPrincipalBinding(), toolName, args, resumeStrategy);
}

function cinemaInterventionPrompt(intervention: CinemaIntervention): string {
  const label = intervention.reason === "access_challenge"
    ? "an access challenge or CAPTCHA"
    : intervention.reason === "sign_in"
      ? "a sign-in or authentication step"
      : intervention.reason === "consent"
        ? "a consent step"
        : "a manual identity, consent, or transaction step outside the reviewed automation surface";
  return [
    `The cinema browser requires ${label}.`,
    "Complete the manual step directly in the dedicated Chrome window.",
    "Do not paste passwords, OTP/MFA codes, CAPTCHA answers, cookies, payment-card data, bank data, or other credentials into this MCP prompt.",
    "Choose Continue only after the manual browser step is complete, or Cancel to stop the operation."
  ].join(" ");
}

async function humanInputRequired(
  intervention: CinemaIntervention,
  candidateOwner: HandoffOwner,
  args: unknown
): Promise<InputRequiredResult | CallToolResult> {
  const owner = handoffOwners.get(intervention.id);
  if (!owner || !handoffOwnerMatches(owner, candidateOwner)) {
    return errorResult(new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "The active Human intervention belongs to another invocation or no longer has a valid owner. Complete or cancel the original cinema flow first."
    ));
  }

  let active = executionAdapter.control.getActiveIntervention();
  if (!active || active.id !== intervention.id) {
    handoffOwners.delete(intervention.id);
    return errorResult(new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "The Human intervention is no longer active. Re-read the current cinema page before continuing."
    ));
  }
  if (active.status === "awaiting_human") {
    active = executionAdapter.control.claimHumanControl(active.id);
  }
  if (active.status !== "human_active") {
    return errorResult(new BrowserRuntimeError(
      "HUMAN_ACTION_REQUIRED",
      `The active Human intervention is ${active.status}; finish the original handoff flow first.`
    ));
  }

  const requestState = await handoffStateCodec.mint(createHandoffRequestState({
    toolName: owner.toolName,
    args,
    interventionId: active.id,
    epoch: active.epoch,
    resumeStrategy: owner.resumeStrategy,
    principalBinding: owner.principalBinding
  }));

  return inputRequired({
    requestState,
    inputRequests: {
      [HANDOFF_INPUT_KEY]: inputRequired.elicit({
        message: cinemaInterventionPrompt(active),
        requestedSchema: HUMAN_INTERVENTION_SCHEMA
      })
    }
  });
}

function cancelIntervention(interventionId: string): CallToolResult {
  const active = executionAdapter.control.getActiveIntervention();
  if (active?.id === interventionId) executionAdapter.control.cancelHumanIntervention(interventionId);
  handoffOwners.delete(interventionId);
  purchaseGate.clear();
  return jsonResult({ cancelled: true, reason: "human_intervention_cancelled" });
}

function staleAfterInterventionResult(): CallToolResult {
  purchaseGate.clear();
  return errorResult(new BrowserRuntimeError(
    "UI_STATE_CHANGED",
    "Human intervention completed, but the interrupted cinema operation was not replayed. Re-read the current provider state and issue a fresh semantic action. Seat, checkout, purchase, and payment actions always require fresh intent and a new explicit confirmation where applicable."
  ));
}

async function executeToolTask<T>(
  toolName: string,
  args: unknown,
  resumeStrategy: HandoffResumeStrategy,
  task: () => Promise<T>,
  timeoutMs = config.policy.operationTimeoutMs
): Promise<CallToolResult | InputRequiredResult> {
  const owner = ownerFor(toolName, args, resumeStrategy);
  try {
    const result = await operationQueue.run(async () => {
      // Cold Chromium startup is bounded separately by ChromeProcess.start(). Do
      // not spend the semantic operation budget while the dedicated CDP session
      // itself is being created.
      await runtime.prepare();
      return runTimedBrowserOperation(
        runtime,
        {
          timeoutMs,
          message: `Cinema browser operation exceeded ${timeoutMs}ms and the dedicated browser session was reset.`,
          details: { scope: "tool", toolName }
        },
        async () => {
          const interventionBefore = executionAdapter.control.getActiveIntervention()?.id;
          try {
            return await task();
          } finally {
            const interventionAfter = executionAdapter.control.getActiveIntervention();
            if (interventionAfter && interventionAfter.id !== interventionBefore) {
              const boundOwner = claimHandoffOwner(
                handoffOwners,
                interventionAfter.id,
                interventionAfter.status,
                owner
              );
              if (!boundOwner) {
                executionAdapter.control.cancelHumanIntervention(interventionAfter.id);
                throw new BrowserRuntimeError(
                  "UI_STATE_CHANGED",
                  "A newly-created Human intervention could not be bound to its originating invocation and was cancelled."
                );
              }
              // Human browser activity invalidates every prepared transaction confirmation.
              purchaseGate.clear();
            }
          }
        }
      );
    });
    return jsonResult(result);
  } catch (error) {
    if (
      error instanceof BrowserRuntimeError &&
      error.code === "HUMAN_ACTION_REQUIRED" &&
      error.intervention
    ) {
      if (config.remote.disableHumanHandoff) {
        return errorResult(new BrowserRuntimeError(
          "HUMAN_ACTION_REQUIRED",
          "The remote headless cinema runtime encountered a sign-in, consent, or access challenge and will not bypass it. Retry later or use the local headed stdio runtime for manual handoff."
        ));
      }
      return humanInputRequired(error.intervention, owner, args);
    }
    return errorResult(error);
  }
}

async function runToolWithHandoffUnmetered<T>(input: {
  toolName: string;
  args: unknown;
  resumeStrategy: HandoffResumeStrategy;
  ctx: ServerContext;
  task: () => Promise<T>;
  timeoutMs?: number;
}): Promise<CallToolResult | InputRequiredResult> {
  const state = input.ctx.mcpReq.requestState<HandoffRequestState>();
  if (!state) {
    return executeToolTask(input.toolName, input.args, input.resumeStrategy, input.task, input.timeoutMs);
  }

  if (!handoffStateMatchesInvocation(state, input.toolName, input.args, currentPrincipalBinding())) {
    return errorResult(new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "The returned MCP requestState does not match this cinema tool invocation. Re-read the current cinema state instead of reusing stale handoff state."
    ));
  }

  const expectedOwner = ownerFor(input.toolName, input.args, input.resumeStrategy);
  const owner = handoffOwners.get(state.interventionId);
  if (!owner || !handoffOwnerMatches(owner, expectedOwner)) {
    return errorResult(new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "The Human intervention owner does not match this invocation. Restart from the current reviewed cinema state."
    ));
  }

  const active = executionAdapter.control.getActiveIntervention();
  if (!active || active.id !== state.interventionId || active.epoch !== state.epoch) {
    handoffOwners.delete(state.interventionId);
    purchaseGate.clear();
    return errorResult(new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "The browser changed while waiting for Human intervention. Re-read the current cinema state before continuing."
    ));
  }

  const response = inputResponse(input.ctx.mcpReq.inputResponses, HANDOFF_INPUT_KEY);
  if (response.kind === "missing") return humanInputRequired(active, owner, input.args);
  if (response.kind !== "elicit" || response.action !== "accept") return cancelIntervention(state.interventionId);

  const content = acceptedContent(input.ctx.mcpReq.inputResponses, HANDOFF_INPUT_KEY, handoffDecisionSchema);
  if (!content) return humanInputRequired(active, owner, input.args);
  if (content.decision === "cancel") return cancelIntervention(state.interventionId);

  try {
    executionAdapter.control.markHumanControlComplete(state.interventionId);
    await operationQueue.run(() => executionAdapter.control.verifyHumanIntervention(state.interventionId));
  } catch (error) {
    const stillActive = executionAdapter.control.getActiveIntervention();
    if (
      error instanceof BrowserRuntimeError &&
      error.code === "HUMAN_ACTION_REQUIRED" &&
      stillActive?.id === state.interventionId &&
      stillActive.status === "verifying"
    ) {
      const returned = executionAdapter.control.claimHumanControl(state.interventionId);
      return humanInputRequired(returned, owner, input.args);
    }
    if (stillActive?.id === state.interventionId) executionAdapter.control.cancelHumanIntervention(state.interventionId);
    handoffOwners.delete(state.interventionId);
    purchaseGate.clear();
    return errorResult(error);
  }

  const decision = executionAdapter.control.resumeAfterHumanIntervention(state.interventionId);
  handoffOwners.delete(state.interventionId);
  if (decision.resumePolicy !== "replay_safe" || input.resumeStrategy === "require_fresh_semantic_action") {
    return staleAfterInterventionResult();
  }

  return executeToolTask(input.toolName, input.args, input.resumeStrategy, input.task, input.timeoutMs);
}

async function runToolWithHandoff<T>(input: {
  toolName: string;
  args: unknown;
  resumeStrategy: HandoffResumeStrategy;
  ctx: ServerContext;
  task: () => Promise<T>;
  timeoutMs?: number;
}): Promise<CallToolResult | InputRequiredResult> {
  if (!usageRuntime) return runToolWithHandoffUnmetered(input);
  const principal = currentRequestPrincipal();
  if (!principal) {
    return errorResult(new Error("MCP usage control requires an authenticated HTTP principal"));
  }
  try {
    return await usageRuntime.execute({
      operationId: `${principal.operationScope ?? "stdio"}:${String(input.ctx.mcpReq.id)}`,
      principalId: principalBinding(principal),
      tool: input.toolName,
      args: input.args,
      task: () => runToolWithHandoffUnmetered(input)
    });
  } catch (error) {
    return errorResult(error);
  }
}

function requireReadAdapter(provider: CinemaProviderId, capability: "theaters" | "showtimes"): CinemaReadAdapter {
  assertProviderCapability(provider, capability);
  if (provider === "toho") return tohoReadAdapter;
  if (provider === "aeon") return aeonReadAdapter;
  if (provider === "109") return cinemas109ReadAdapter;
  throw new ProviderPolicyError(
    "UNSUPPORTED_CAPABILITY",
    `Read adapter for '${capability}' is not available.`
  );
}

const MAX_FIND_SHOWTIMES_TIMEOUT_MS = 120_000;

function findShowtimesTimeoutMs(targetCount: number): number {
  return Math.min(
    MAX_FIND_SHOWTIMES_TIMEOUT_MS,
    config.policy.operationTimeoutMs * targetCount + 5_000
  );
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "japan-cinema-browser-mcp", version: SERVER_VERSION },
    {
      requestState: { verify: handoffStateCodec.verify },
      inputRequired: { maxRounds: 4, roundTimeoutMs: HANDOFF_STATE_TTL_SECONDS * 1_000 }
    }
  );

  server.registerTool(
    "list_cinema_providers",
    {
      title: "List Japanese cinema providers",
      description: "List reviewed Japanese cinema providers, official roots, and currently enabled granular capabilities.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => jsonResult(Object.values(CINEMA_PROVIDERS))
  );

  server.registerTool(
    "browser_status",
    {
      title: "Cinema browser status",
      description: "Check the local Chrome/CDP session and current provider surface.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => safe(() => runtime.status())
  );

  server.registerTool(
    "open_cinema_provider",
    {
      title: "Open cinema provider",
      description: "Open an official TOHO Cinemas, AEON Cinema, or 109 Cinemas root page in the controlled Chrome session.",
      inputSchema: z.object({ provider: providerSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ provider }, ctx) => runToolWithHandoff({
      toolName: "open_cinema_provider",
      args: { provider },
      resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
      ctx,
      task: () => runtime.openProvider(provider)
    })
  );

  server.registerTool(
    "navigate_cinema_official",
    {
      title: "Navigate official cinema page",
      description: "Navigate only to explicitly reviewed public read surfaces for TOHO Cinemas, AEON Cinema, or 109 Cinemas. Arbitrary same-domain paths, private/internal-like routes, credentials, and non-default ports are refused.",
      inputSchema: z.object({
        url: z.string().url().max(2_048),
        provider: providerSchema.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ url, provider }, ctx) => runToolWithHandoff({
      toolName: "navigate_cinema_official",
      args: { url, ...(provider ? { provider } : {}) },
      resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
      ctx,
      task: async () => ({ url: await runtime.navigate(url, provider) })
    })
  );

  server.registerTool(
    "read_cinema_page",
    {
      title: "Read visible cinema page",
      description: "Read a bounded visible-text snapshot of the current official cinema page. Raw HTML is never returned or persisted.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (_args, ctx) => runToolWithHandoff({
      toolName: "read_cinema_page",
      args: {},
      resumeStrategy: CINEMA_HANDOFF_POLICY.read.resumeStrategy,
      ctx,
      task: () => runtime.readVisibleText()
    })
  );

  server.registerTool(
    "extract_showtime_candidates",
    {
      title: "Extract visible showtimes",
      description: "Extract likely HH:MM showtime candidates and short surrounding text from the currently visible official cinema page.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async (_args, ctx) => runToolWithHandoff({
      toolName: "extract_showtime_candidates",
      args: {},
      resumeStrategy: CINEMA_HANDOFF_POLICY.read.resumeStrategy,
      ctx,
      task: () => runtime.extractShowtimeCandidates()
    })
  );

  server.registerTool(
    "list_theaters",
    {
      title: "List cinema theaters",
      description: "Read reviewed theater controls from the provider's current official public UI. TOHO Cinemas, AEON Cinema, and 109 Cinemas are enabled in Phase 1; unsupported provider capabilities fail closed.",
      inputSchema: z.object({
        provider: providerSchema,
        query: shortText.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ provider, query }, ctx) => runToolWithHandoff({
      toolName: "list_theaters",
      args: { provider, ...(query ? { query } : {}) },
      resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
      ctx,
      task: () => requireReadAdapter(provider, "theaters").listTheaters(query)
    })
  );

  server.registerTool(
    "get_showtimes",
    {
      title: "Get cinema showtimes",
      description: "Read theater/date/movie/showtime facts from the provider's rendered official public UI. TOHO Cinemas, AEON Cinema, and 109 Cinemas are enabled. This never calls private/internal APIs and never enters the purchase flow.",
      inputSchema: z.object({
        provider: providerSchema,
        theater: shortText,
        date: isoDate.optional(),
        movie: shortText.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ provider, theater, date, movie }, ctx) => runToolWithHandoff({
      toolName: "get_showtimes",
      args: { provider, theater, ...(date ? { date } : {}), ...(movie ? { movie } : {}) },
      resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
      ctx,
      task: () => requireReadAdapter(provider, "showtimes").getShowtimes({
        theater,
        ...(date ? { date } : {}),
        ...(movie ? { movie } : {})
      })
    })
  );

  server.registerTool(
    "resolve_theater_targets",
    {
      title: "Resolve external cinema place candidates",
      description: "Convert up to eight bounded external place labels (for example maps_read_place_summary items) into at most three verified provider/theater targets. Labels are treated as untrusted data and are re-resolved through each provider's reviewed official theater UI before a target is returned. Unsupported, ambiguous, failed, duplicate, and over-limit candidates remain explicit.",
      inputSchema: z.object({
        candidates: z.array(z.object({
          index: z.number().int().min(0).max(10_000).optional(),
          label: shortText
        })).min(1).max(8),
        sourceTruncated: z.boolean().optional(),
        limit: z.number().int().min(1).max(3).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ candidates, sourceTruncated, limit }, ctx) => runToolWithHandoff({
      toolName: "resolve_theater_targets",
      args: {
        candidates,
        ...(sourceTruncated !== undefined ? { sourceTruncated } : {}),
        ...(limit !== undefined ? { limit } : {})
      },
      resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
      ctx,
      task: () => resolveTheaterTargets(
        {
          candidates,
          ...(sourceTruncated !== undefined ? { sourceTruncated } : {}),
          ...(limit !== undefined ? { limit } : {})
        },
        (provider) => requireReadAdapter(provider, "theaters")
      )
    })
  );

  server.registerTool(
    "find_showtimes",
    {
      title: "Find showtimes across cinema providers",
      description: "Read and combine showtimes for up to three explicit provider/theater targets using the shared cinema contract. Provider failures remain explicit; successful partial results are never presented as complete. Area-wide crawling is not performed.",
      inputSchema: z.object({
        targets: z.array(z.object({
          provider: providerSchema,
          theater: shortText
        })).min(1).max(3),
        date: isoDate.optional(),
        movie: shortText.optional(),
        after: clockTime.optional(),
        before: clockTime.optional(),
        format: z.enum(SHOWTIME_FORMATS).optional()
      }).refine(
        (value) => !value.after || !value.before || value.after <= value.before,
        { message: "after must not be later than before", path: ["after"] }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ targets, date, movie, after, before, format }, ctx) => runToolWithHandoff({
      toolName: "find_showtimes",
      args: {
        targets,
        ...(date ? { date } : {}),
        ...(movie ? { movie } : {}),
        ...(after ? { after } : {}),
        ...(before ? { before } : {}),
        ...(format ? { format } : {})
      },
      resumeStrategy: CINEMA_HANDOFF_POLICY.navigation.resumeStrategy,
      ctx,
      timeoutMs: findShowtimesTimeoutMs(targets.length),
      task: () => findShowtimes(
        {
          targets,
          ...(date ? { date } : {}),
          ...(movie ? { movie } : {}),
          ...(after ? { after } : {}),
          ...(before ? { before } : {}),
          ...(format ? { format } : {})
        },
        (provider) => requireReadAdapter(provider, "showtimes"),
        new Date(),
        {
          runTarget: (target, providerTask) => runTimedBrowserOperation(
            runtime,
            {
              timeoutMs: config.policy.operationTimeoutMs,
              message: `Cinema provider '${target.provider}' read exceeded ${config.policy.operationTimeoutMs}ms and was isolated from sibling targets.`,
              details: {
                scope: "find_showtimes_target",
                provider: target.provider,
                theater: target.theater
              }
            },
            providerTask
          )
        }
      )
    })
  );

  server.registerTool(
    "click_cinema_control",
    {
      title: "Click cinema control",
      description: "Click one uniquely matching visible control only when it stays within reviewed public read surfaces or is an explicitly reviewed read-only interaction. Seat, checkout, and purchase workflow controls are gated by provider capabilities and are currently disabled.",
      inputSchema: z.object({ label: shortText }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ label }, ctx) => runToolWithHandoff({
      toolName: "click_cinema_control",
      args: { label },
      resumeStrategy: CINEMA_HANDOFF_POLICY.semantic_mutation.resumeStrategy,
      ctx,
      task: () => runtime.clickControl(label)
    })
  );

  server.registerTool(
    "fill_cinema_field",
    {
      title: "Fill cinema field",
      description: "Fill one uniquely matching reviewed read-only search/filter field. Seat/checkout fields require enabled provider capabilities; passwords, card details, CVV/CVC, OTP/MFA and verification codes are always refused.",
      inputSchema: z.object({
        label: shortText,
        value: z.string().max(1_000)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ label, value }, ctx) => runToolWithHandoff({
      toolName: "fill_cinema_field",
      args: { label, value },
      resumeStrategy: CINEMA_HANDOFF_POLICY.semantic_mutation.resumeStrategy,
      ctx,
      task: () => runtime.fillField(label, value)
    })
  );

  server.registerTool(
    "prepare_purchase_confirmation",
    {
      title: "Prepare cinema purchase confirmation",
      description: "Prepare a short-lived one-shot confirmation bound to the exact current page and material purchase details. This does not click the final purchase/payment control.",
      inputSchema: z.object({
        provider: providerSchema,
        theater: shortText,
        movie: shortText,
        date: z.string().trim().min(1).max(40),
        time: z.string().trim().min(1).max(40),
        seats: z.array(z.string().trim().min(1).max(40)).max(12),
        ticketSummary: z.string().trim().min(1).max(500),
        amountYen: z.number().int().nonnegative().max(1_000_000).optional(),
        finalControlLabel: shortText
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async (input) => safe(async () => {
      if (!isFinalPurchaseLabel(input.finalControlLabel)) {
        throw new BrowserRuntimeError(
          "UI_STATE_CHANGED",
          "The proposed final control does not look like a purchase/payment/booking-finalization control."
        );
      }
      const status = await runtime.status();
      const url = typeof status.url === "string" ? status.url : undefined;
      const currentProvider = status.provider as CinemaProviderId | null | undefined;
      if (!url || currentProvider !== input.provider) {
        throw new BrowserRuntimeError(
          "UI_STATE_CHANGED",
          "The browser is not currently on the provider page represented by this purchase summary."
        );
      }
      const summary: PurchaseSummary = { ...input };
      const confirmation = purchaseGate.prepare(summary, url);
      return {
        ...confirmation,
        summary,
        requiresExplicitUserConfirmation: true,
        purchaseExecutionEnabled:
          config.policy.enablePurchase && CINEMA_PROVIDERS[input.provider].capabilities.purchaseSubmission
      };
    })
  );

  server.registerTool(
    "confirm_purchase_action",
    {
      title: "Confirm and submit cinema purchase",
      description: "CONSEQUENTIAL ACTION. Call only after the user explicitly approves the exact summary returned by prepare_purchase_confirmation. The token is short-lived, URL-bound and one-shot.",
      inputSchema: z.object({ confirmationId: z.string().trim().min(1).max(200) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ confirmationId }, ctx) => runToolWithHandoff({
      toolName: "confirm_purchase_action",
      args: { confirmationId },
      resumeStrategy: CINEMA_HANDOFF_POLICY.transaction.resumeStrategy,
      ctx,
      task: async () => {
        if (!config.policy.enablePurchase) {
          throw new BrowserRuntimeError(
            "FINAL_ACTION_REQUIRES_CONFIRMATION",
            "Final purchase execution is disabled. Set CINEMA_ENABLE_PURCHASE=true only after reviewing the provider flow."
          );
        }
        const confirmation = purchaseGate.consume(confirmationId);
        assertProviderCapability(confirmation.summary.provider, "purchaseSubmission");
        const status = await runtime.status();
        if (status.url !== confirmation.expectedUrl || status.provider !== confirmation.summary.provider) {
          throw new BrowserRuntimeError(
            "UI_STATE_CHANGED",
            "The browser page changed after confirmation was prepared. Re-read the page and prepare a new confirmation."
          );
        }
        return runtime.finalPurchaseClick(
          confirmation.summary.finalControlLabel,
          confirmation.summary.provider
        );
      }
    })
  );

  server.registerTool(
    "close_browser_session",
    {
      title: "Close cinema browser session",
      description: "Close the MCP-owned CDP connection and dedicated Chrome process. Externally managed Chrome is left running.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async () => safe(async () => {
      purchaseGate.clear();
      await runtime.close();
      return { closed: true };
    })
  );

  return server;
}

export async function probeBrowserReady(): Promise<void> {
  const status = await runtime.status();
  if (status.connected !== true) throw new Error("Cinema browser is unavailable");
}

export async function shutdownRuntime(): Promise<void> {
  purchaseGate.clear();
  await runtime.close();
  await usageRuntime?.close().catch(() => undefined);
}
