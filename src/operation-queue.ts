/**
 * Consumer-local serialization for CDP operations. Execution Handoff owns
 * authority; this queue only prevents parallel browser tasks from racing the
 * point where a fresh intervention is bound to its originating invocation.
 */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}
