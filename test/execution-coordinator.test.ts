import { describe, expect, it } from "bun:test";
import { ExecutionCoordinator } from "../extensions/subagent/execution-coordinator.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("execution coordinator", () => {
  it("reserves synchronously, hands capacity to queued work, and releases only once", async () => {
    const coordinator = new ExecutionCoordinator(1);
    const directToolLease = coordinator.tryAcquire();
    if (!directToolLease) throw new Error("direct tool did not reserve capacity");
    const workflowLease = coordinator.acquire();

    expect(coordinator.activeCount).toBe(1);
    expect(coordinator.queuedCount).toBe(1);

    directToolLease.release();
    directToolLease.release();
    const acquiredWorkflowLease = await workflowLease;
    expect(coordinator.activeCount).toBe(1);

    acquiredWorkflowLease.release();
    expect(coordinator.activeCount).toBe(0);
  });

  it("rejects a direct tool or workflow lease that is aborted while queued", async () => {
    const coordinator = new ExecutionCoordinator(1);
    const btwLease = coordinator.tryAcquire();
    if (!btwLease) throw new Error("/btw did not reserve capacity");
    const controller = new AbortController();
    const queuedWorkflow = coordinator.acquire(controller.signal);

    controller.abort();
    await expect(queuedWorkflow).rejects.toMatchObject({ name: "AbortError" });
    await expect(coordinator.acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(coordinator.queuedCount).toBe(0);

    btwLease.release();
    expect(coordinator.activeCount).toBe(0);
  });

  it("rejects queued permits on shutdown without closing the reusable coordinator", async () => {
    const coordinator = new ExecutionCoordinator(1);
    const active = coordinator.tryAcquire();
    if (!active) throw new Error("active lease was not acquired");
    const queued = coordinator.acquire();

    coordinator.rejectQueued();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.queuedCount).toBe(0);
    expect(coordinator.activeCount).toBe(1);

    active.release();
    const rebound = await coordinator.acquire();
    expect(coordinator.activeCount).toBe(1);
    rebound.release();
    expect(coordinator.activeCount).toBe(0);
  });

  it("lets /btw reject immediately instead of entering the shared queue", () => {
    const coordinator = new ExecutionCoordinator(1);
    const activeWorkflow = coordinator.tryAcquire();
    if (!activeWorkflow) throw new Error("workflow did not reserve capacity");

    expect(coordinator.tryAcquire()).toBeUndefined();
    expect(coordinator.queuedCount).toBe(0);

    activeWorkflow.release();
  });

  it("keeps a four-permit cross-surface race below the global cap", async () => {
    const coordinator = new ExecutionCoordinator();
    const started = Array.from({ length: 4 }, () => coordinator.tryAcquire());
    const queuedDirectTool = deferred<void>();
    const waiting = coordinator.acquire().then((lease) => {
      queuedDirectTool.resolve();
      return lease;
    });

    expect(started.every(Boolean)).toBe(true);
    expect(coordinator.activeCount).toBe(4);
    expect(coordinator.tryAcquire()).toBeUndefined();

    started[0]!.release();
    await queuedDirectTool.promise;
    const queuedLease = await waiting;
    expect(coordinator.activeCount).toBe(4);

    queuedLease.release();
    for (const lease of started.slice(1)) lease!.release();
    expect(coordinator.activeCount).toBe(0);
  });
});
