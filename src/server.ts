import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { ChromeProcess } from "./browser/chrome-process.js";
import { BrowserRuntimeError, CinemaBrowserRuntime } from "./browser/runtime.js";
import {
  CINEMA_PROVIDERS,
  ProviderPolicyError,
  isFinalPurchaseLabel,
  type CinemaProviderId
} from "./providers.js";
import { TohoReadAdapter } from "./providers/toho/adapter.js";
import { PurchaseGate, PurchaseGateError, type PurchaseSummary } from "./purchase-gate.js";

const SERVER_VERSION = "0.1.0";
export const config = loadConfig();
const chrome = new ChromeProcess(config.browser);
const runtime = new CinemaBrowserRuntime(chrome, config.policy.maxReadChars);
const tohoReadAdapter = new TohoReadAdapter(runtime);
const purchaseGate = new PurchaseGate(config.policy.confirmationTtlMs);

const providerSchema = z.enum(["toho", "aeon", "109"]);
const shortText = z.string().trim().min(1).max(240);
const isoDate = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const known =
    error instanceof BrowserRuntimeError ||
    error instanceof ProviderPolicyError ||
    error instanceof PurchaseGateError;
  if (!known) console.error("[japan-cinema-browser-mcp] unexpected tool error", error);
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known
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

function requireReadAdapter(provider: CinemaProviderId): TohoReadAdapter {
  if (provider !== "toho") {
    throw new ProviderPolicyError(
      "UNSUPPORTED_CAPABILITY",
      `${CINEMA_PROVIDERS[provider].name} semantic theater/showtime reading is not enabled yet.`
    );
  }
  return tohoReadAdapter;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "japan-cinema-browser-mcp", version: SERVER_VERSION });

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
    async ({ provider }) => safe(() => runtime.openProvider(provider))
  );

  server.registerTool(
    "navigate_cinema_official",
    {
      title: "Navigate official cinema page",
      description: "Navigate to an HTTPS page under a reviewed official cinema domain. Private/internal APIs and third-party surfaces are not allowed.",
      inputSchema: z.object({
        url: z.string().url().max(2_048),
        provider: providerSchema.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ url, provider }) => safe(async () => ({ url: await runtime.navigate(url, provider) }))
  );

  server.registerTool(
    "read_cinema_page",
    {
      title: "Read visible cinema page",
      description: "Read a bounded visible-text snapshot of the current official cinema page. Raw HTML is never returned or persisted.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => safe(() => runtime.readVisibleText())
  );

  server.registerTool(
    "extract_showtime_candidates",
    {
      title: "Extract visible showtimes",
      description: "Extract likely HH:MM showtime candidates and short surrounding text from the currently visible official cinema page.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => safe(() => runtime.extractShowtimeCandidates())
  );

  server.registerTool(
    "list_theaters",
    {
      title: "List cinema theaters",
      description: "Read reviewed theater links from the provider's current official public UI. TOHO Cinemas is enabled in Phase 1; unsupported provider capabilities fail closed.",
      inputSchema: z.object({
        provider: providerSchema,
        query: shortText.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ provider, query }) => safe(() => requireReadAdapter(provider).listTheaters(query))
  );

  server.registerTool(
    "get_showtimes",
    {
      title: "Get cinema showtimes",
      description: "Read theater/date/movie/showtime facts from the provider's rendered official public UI. This never calls private/internal APIs and never enters the purchase flow.",
      inputSchema: z.object({
        provider: providerSchema,
        theater: shortText,
        date: isoDate.optional(),
        movie: shortText.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ provider, theater, date, movie }) => safe(() => requireReadAdapter(provider).getShowtimes({
      theater,
      ...(date ? { date } : {}),
      ...(movie ? { movie } : {})
    }))
  );

  server.registerTool(
    "click_cinema_control",
    {
      title: "Click cinema control",
      description: "Click one uniquely matching visible link or button on the current official cinema page. Final purchase/payment/booking controls are refused and require the separate confirmation flow.",
      inputSchema: z.object({ label: shortText }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ label }) => safe(() => runtime.clickControl(label))
  );

  server.registerTool(
    "fill_cinema_field",
    {
      title: "Fill cinema field",
      description: "Fill one uniquely matching non-sensitive visible form field. Passwords, card details, CVV/CVC, OTP/MFA and verification codes are always refused.",
      inputSchema: z.object({
        label: shortText,
        value: z.string().max(1_000)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ label, value }) => safe(() => runtime.fillField(label, value))
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
        purchaseExecutionEnabled: config.policy.enablePurchase
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
    async ({ confirmationId }) => safe(async () => {
      if (!config.policy.enablePurchase) {
        throw new BrowserRuntimeError(
          "FINAL_ACTION_REQUIRES_CONFIRMATION",
          "Final purchase execution is disabled. Set CINEMA_ENABLE_PURCHASE=true only after reviewing the provider flow."
        );
      }
      const confirmation = purchaseGate.consume(confirmationId);
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

export async function shutdownRuntime(): Promise<void> {
  purchaseGate.clear();
  await runtime.close();
}
