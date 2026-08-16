import { Firestore } from "@google-cloud/firestore";
import { UsageControl, UsageDeniedError, type UsagePolicy } from "mcp-usage-control";
import { FirestoreUsageStore } from "mcp-usage-control-firestore";

export interface CinemaUsageConfig {
  projectId: string;
  dailyLimit: number;
  leaseTtlMs: number;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
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
    try {
      const result = await input.task();
      const returnedToolError =
        typeof result === "object" &&
        result !== null &&
        "isError" in result &&
        (result as { isError?: unknown }).isError === true;
      await admission.lease.settle(1, returnedToolError ? "error" : "completed");
      return result;
    } catch (error) {
      try {
        await admission.lease.settle(1, "error");
      } catch (settlementError) {
        console.error("[japan-cinema-browser-mcp] MCP usage settlement failed", {
          errorName: settlementError instanceof Error ? settlementError.name : "UnknownError"
        });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.firestore.terminate();
  }
}
