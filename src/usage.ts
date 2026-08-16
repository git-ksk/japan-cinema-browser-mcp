import { Firestore } from "@google-cloud/firestore";
import { UsageControl, UsageDeniedError, type UsageLease, type UsagePolicy } from "mcp-usage-control";
import { FirestoreUsageStore } from "mcp-usage-control-firestore";

export interface CinemaUsageConfig {
  projectId: string;
  dailyLimit: number;
  leaseTtlMs: number;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function returnedToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    (result as { isError?: unknown }).isError === true
  );
}

async function settleBestEffort(
  lease: Pick<UsageLease, "settle">,
  outcome: "completed" | "error"
): Promise<void> {
  try {
    await lease.settle(1, outcome);
  } catch (settlementError) {
    // markLiable() runs before the browser task. The Firestore store retains the
    // full reserved unit when an expired liable reservation is recovered, so a
    // settlement failure cannot create extra admission capacity. Treat settle
    // as post-task accounting and never replace the real cinema tool outcome.
    console.error("[japan-cinema-browser-mcp] MCP usage settlement failed", {
      errorName: settlementError instanceof Error ? settlementError.name : "UnknownError"
    });
  }
}

export async function executeLiableUsageTask<T>(
  lease: Pick<UsageLease, "settle">,
  task: () => Promise<T>
): Promise<T> {
  let result: T;
  try {
    result = await task();
  } catch (error) {
    await settleBestEffort(lease, "error");
    throw error;
  }

  await settleBestEffort(lease, returnedToolError(result) ? "error" : "completed");
  return result;
}

export class CinemaUsageRuntime {
  private readonly firestore: Firestore;
  private readonly control: UsageControl;

  constructor(private readonly config: CinemaUsageConfig) {
    this.firestore = new Firestore({ projectId: config.projectId });
    const store = new FirestoreUsageStore(this.firestore, {
      collectionPrefix: "cinema_muc",
      cleanupBatchSize: 8,
      cleanupIntervalMs: 10_000
    });
    const policy: UsagePolicy = {
      quote: (request) => ({
        decision: "allow",
        units: 1,
        reservationTtlMs: config.leaseTtlMs,
        budget: {
          key: `cinema:user:${request.principal.id}:day:${utcDay()}`,
          limit: config.dailyLimit
        }
      })
    };
    this.control = new UsageControl(store, policy, {
      defaultReservationTtlMs: config.leaseTtlMs,
      metadata: (request) => ({ service: "japan-cinema-browser-mcp", tool: request.tool })
    });
  }

  async execute<T>(input: {
    operationId: string;
    principalId: string;
    tool: string;
    args: unknown;
    task: () => Promise<T>;
  }): Promise<T> {
    const admission = await this.control.reserve({
      operationId: input.operationId,
      principal: { id: input.principalId },
      tool: input.tool,
      args: input.args
    });
    if (!admission.allowed) throw new UsageDeniedError(admission.reason);

    await admission.lease.markLiable();
    return executeLiableUsageTask(admission.lease, input.task);
  }

  async close(): Promise<void> {
    await this.firestore.terminate();
  }
}
