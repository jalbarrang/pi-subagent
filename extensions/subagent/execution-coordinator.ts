export const MAX_SUBAGENT_EXECUTIONS = 4;

export interface ExecutionLease {
  release(): void;
}

interface QueuedLease {
  resolve(lease: ExecutionLease): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort(): void;
}

function abortError(message = "Subagent execution was aborted while waiting for capacity."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** A process-wide permit pool for child execution, not a run registry. */
export class ExecutionCoordinator {
  private active = 0;
  private readonly queue: QueuedLease[] = [];

  constructor(private readonly limit = MAX_SUBAGENT_EXECUTIONS) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  tryAcquire(): ExecutionLease | undefined {
    if (this.active >= this.limit) return undefined;
    this.active += 1;
    return this.createLease();
  }

  /** Reject only current waiters; later sessions can acquire permits normally. */
  rejectQueued(reason = "Subagent execution was cancelled because the session ended."): void {
    for (const queued of this.queue.splice(0)) {
      queued.signal?.removeEventListener("abort", queued.abort);
      queued.reject(abortError(reason));
    }
  }

  acquire(signal?: AbortSignal): Promise<ExecutionLease> {
    if (signal?.aborted) return Promise.reject(abortError());
    const lease = this.tryAcquire();
    if (lease) return Promise.resolve(lease);
    return new Promise<ExecutionLease>((resolve, reject) => {
      const queued: QueuedLease = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(queued);
          if (index === -1) return;
          this.queue.splice(index, 1);
          signal?.removeEventListener("abort", queued.abort);
          reject(abortError());
        },
      };
      signal?.addEventListener("abort", queued.abort, { once: true });
      this.queue.push(queued);
    });
  }

  private createLease(): ExecutionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  private release(): void {
    this.active -= 1;
    const queued = this.queue.shift();
    if (!queued) return;
    queued.signal?.removeEventListener("abort", queued.abort);
    this.active += 1;
    queued.resolve(this.createLease());
  }
}

export const executionCoordinator = new ExecutionCoordinator();
