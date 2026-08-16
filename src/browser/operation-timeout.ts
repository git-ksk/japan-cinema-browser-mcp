import { BrowserRuntimeError } from "./runtime.js";

export interface AbortableBrowserOperationRuntime {
  runOperation<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface TimedBrowserOperationOptions {
  timeoutMs: number;
  message: string;
  details?: Record<string, unknown>;
}

export async function runTimedBrowserOperation<T>(
  runtime: AbortableBrowserOperationRuntime,
  options: TimedBrowserOperationOptions,
  task: () => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new BrowserRuntimeError(
    "OPERATION_TIMEOUT",
    options.message,
    { timeoutMs: options.timeoutMs, ...(options.details ?? {}) }
  );
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const work = runtime.runOperation(controller.signal, task);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (!timedOut) throw error;

    // A timeout must not leave the losing Promise.race branch running against
    // the shared CDP session. Abort first, close the current session to wake any
    // in-flight CDP command, then wait for the task to observe the abort before
    // allowing the serialized queue to advance to a sibling provider/tool call.
    await runtime.close().catch(() => undefined);
    await work.catch(() => undefined);
    throw timeoutError;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
