import { describe, expect, it } from "bun:test";

type Listener = (payload: unknown) => void;
type RunStep = () => Promise<string>;
type Snapshot = {
  id: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  phases: Array<{
    startedAt?: string;
    finishedAt?: string;
    output?: string;
    agents?: { done: number; total: number };
  }>;
};

class FakeBus {
  readonly emitted: Array<{ topic: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  on(topic: string, listener: Listener): () => void {
    const listeners = this.listeners.get(topic) ?? [];
    listeners.push(listener);
    this.listeners.set(topic, listeners);
    return () =>
      this.listeners.set(
        topic,
        (this.listeners.get(topic) ?? []).filter((candidate) => candidate !== listener),
      );
  }

  emit(topic: string, payload: unknown): void {
    this.emitted.push({ topic, payload });
    for (const listener of this.listeners.get(topic) ?? []) listener(payload);
  }

  reply(requestId: string): { data: unknown } {
    const event = this.emitted.findLast(({ topic }) => topic.endsWith(`:${requestId}`));
    if (!event) throw new Error(`Missing reply for ${requestId}.`);
    return event.payload as { data: unknown };
  }
}

const {
  registerWorkflowRpc,
  SUBAGENT_RPC_REQUEST_EVENT,
  MAX_WORKFLOW_SNAPSHOT_BYTES,
  MAX_WORKFLOW_SNAPSHOT_LINES,
  WORKFLOW_SNAPSHOT_TRUNCATION_MARKER,
} = await import("../extensions/subagent/workflow-rpc.js").then(async (workflowRpc) => ({
  ...workflowRpc,
  ...(await import("../extensions/subagent/agent-result-utils.js")),
}));

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for workflow progress.");
}

function createHarness(runStep: RunStep): {
  bus: FakeBus;
  start(): void;
  shutdown(): void;
} {
  const bus = new FakeBus();
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => void>>();
  const pi = {
    events: bus,
    on(event: string, listener: (event: unknown, context: unknown) => void) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(listener);
      handlers.set(event, listeners);
    },
  };

  registerWorkflowRpc(pi as never, { runStep: async () => runStep() });
  return {
    bus,
    start: () => {
      for (const handler of handlers.get("session_start") ?? [])
        handler({}, { cwd: process.cwd() });
    },
    shutdown: () => {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
    },
  };
}

function request(bus: FakeBus, requestId: string, method: string, params?: unknown): unknown {
  bus.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 2, requestId, method, params });
  return bus.reply(requestId).data;
}

function workflow(chain: unknown[]): { name: string; task: string; chain: unknown[] } {
  return { name: "snapshot workflow", task: "test snapshots", chain };
}

function snapshotText(snapshot: Snapshot): string[] {
  return [
    ...snapshot.phases.map((phase) => phase.output).filter((text): text is string => !!text),
    ...(snapshot.error ? [snapshot.error] : []),
  ];
}

function expectSnapshotBound(snapshot: Snapshot): void {
  const text = snapshotText(snapshot);
  expect(
    text.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0),
  ).toBeLessThanOrEqual(MAX_WORKFLOW_SNAPSHOT_BYTES);
  expect(text.reduce((total, value) => total + value.split("\n").length, 0)).toBeLessThanOrEqual(
    MAX_WORKFLOW_SNAPSHOT_LINES,
  );
}

describe("workflow RPC snapshots", () => {
  it("tracks fan-out agents and excludes internal run state", async () => {
    const resolvers: Array<() => void> = [];
    let calls = 0;
    const harness = createHarness(async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify({ items: ["one", "two"] });
      return new Promise<string>((resolve) => resolvers.push(() => resolve("complete")));
    });
    harness.start();
    const spawned = request(harness.bus, "spawn", "spawn", {
      workflow: workflow([
        { label: "source", prompt: "source items", as: "source" },
        {
          expand: { from: "source", path: "/items", item: "item", maxItems: 2 },
          parallel: { label: "worker", prompt: "process {item}" },
          collect: { as: "results" },
        },
      ]),
    }) as Snapshot;

    await waitFor(() => resolvers.length === 2);
    const before = request(harness.bus, "before", "status", { id: spawned.id }) as Snapshot;
    expect(JSON.stringify(before)).not.toContain("controller");
    expect(before.phases[1]).toMatchObject({
      startedAt: expect.any(String),
      agents: { done: 0, total: 2 },
    });

    resolvers.shift()!();
    await waitFor(
      () =>
        (request(harness.bus, "during-wait", "status", { id: spawned.id }) as Snapshot).phases[1]
          ?.agents?.done === 1,
    );
    const during = request(harness.bus, "during", "status", { id: spawned.id }) as Snapshot;
    expect(during.phases[1]?.agents).toEqual({ done: 1, total: 2 });

    resolvers.shift()!();
    await waitFor(
      () =>
        (request(harness.bus, "complete-wait", "status", { id: spawned.id }) as Snapshot).status ===
        "completed",
    );
    const completed = request(harness.bus, "complete", "status", { id: spawned.id }) as Snapshot;
    expect(completed.finishedAt).toEqual(expect.any(String));
    expect(completed.phases[1]).toMatchObject({
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      agents: { done: 2, total: 2 },
    });
  });

  it("bounds aggregate successful phase output without changing raw workflow chaining", async () => {
    const large = "x".repeat(Math.floor(MAX_WORKFLOW_SNAPSHOT_BYTES / 2) + 1);
    const harness = createHarness(async () => large);
    harness.start();
    const spawned = request(harness.bus, "success", "spawn", {
      workflow: workflow([{ prompt: "one" }, { prompt: "two" }]),
    }) as Snapshot;
    await waitFor(
      () =>
        (request(harness.bus, "success-status", "status", { id: spawned.id }) as Snapshot)
          .status === "completed",
    );
    const completed = request(harness.bus, "success-complete", "status", {
      id: spawned.id,
    }) as Snapshot;
    expectSnapshotBound(completed);
    expect(snapshotText(completed).join("\n")).toContain(WORKFLOW_SNAPSHOT_TRUNCATION_MARKER);
  });

  it("shares one aggregate output budget across list-status snapshots", async () => {
    const large = "x".repeat(MAX_WORKFLOW_SNAPSHOT_BYTES);
    const harness = createHarness(async () => large);
    harness.start();
    const first = request(harness.bus, "list-first", "spawn", {
      workflow: workflow([{ prompt: "first" }]),
    }) as Snapshot;
    const second = request(harness.bus, "list-second", "spawn", {
      workflow: workflow([{ prompt: "second" }]),
    }) as Snapshot;
    await waitFor(() => {
      const snapshots = request(harness.bus, "list-wait", "status") as Snapshot[];
      return snapshots
        .filter((snapshot) => snapshot.id === first.id || snapshot.id === second.id)
        .every((snapshot) => snapshot.status === "completed");
    });

    const snapshots = request(harness.bus, "list-complete", "status") as Snapshot[];
    const text = snapshots.flatMap(snapshotText);
    expect(
      text.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0),
    ).toBeLessThanOrEqual(MAX_WORKFLOW_SNAPSHOT_BYTES);
    expect(text.reduce((total, value) => total + value.split("\n").length, 0)).toBeLessThanOrEqual(
      MAX_WORKFLOW_SNAPSHOT_LINES,
    );
  });

  it("bounds failure text in snapshots", async () => {
    const large = "failure\n".repeat(MAX_WORKFLOW_SNAPSHOT_LINES);
    const harness = createHarness(async () => {
      throw new Error(large);
    });
    harness.start();
    const spawned = request(harness.bus, "failure", "spawn", {
      workflow: workflow([{ prompt: "fail" }]),
    }) as Snapshot;
    await waitFor(
      () =>
        (request(harness.bus, "failure-status", "status", { id: spawned.id }) as Snapshot)
          .status === "failed",
    );
    const failed = request(harness.bus, "failure-complete", "status", {
      id: spawned.id,
    }) as Snapshot;
    expectSnapshotBound(failed);
    expect(failed.error).toContain(WORKFLOW_SNAPSHOT_TRUNCATION_MARKER);
  });

  it("bounds parallel and fan-out phase snapshots", async () => {
    const large = "x".repeat(MAX_WORKFLOW_SNAPSHOT_BYTES);
    let call = 0;
    const harness = createHarness(async () => {
      call += 1;
      return call === 1 ? JSON.stringify({ items: ["one", "two"] }) : large;
    });
    harness.start();
    const spawned = request(harness.bus, "parallel-fanout", "spawn", {
      workflow: workflow([
        { prompt: "source", as: "source" },
        { parallel: [{ prompt: "parallel one" }, { prompt: "parallel two" }] },
        {
          expand: { from: "source", path: "/items", item: "item", maxItems: 2 },
          parallel: { prompt: "fan-out {item}" },
          collect: { as: "results" },
        },
      ]),
    }) as Snapshot;
    await waitFor(
      () =>
        (request(harness.bus, "parallel-fanout-status", "status", { id: spawned.id }) as Snapshot)
          .status === "completed",
    );
    const completed = request(harness.bus, "parallel-fanout-complete", "status", {
      id: spawned.id,
    }) as Snapshot;
    expectSnapshotBound(completed);
    expect(snapshotText(completed).join("\n")).toContain(WORKFLOW_SNAPSHOT_TRUNCATION_MARKER);
  });

  it("unsubscribes stale listeners so re-registration sends one execution and reply", async () => {
    let calls = 0;
    const harness = createHarness(async () => {
      calls += 1;
      return "complete";
    });
    harness.start();
    harness.shutdown();

    const handlers = new Map<string, Array<(event: unknown, context: unknown) => void>>();
    const pi = {
      events: harness.bus,
      on(event: string, listener: (event: unknown, context: unknown) => void) {
        const listeners = handlers.get(event) ?? [];
        listeners.push(listener);
        handlers.set(event, listeners);
      },
    };
    registerWorkflowRpc(pi as never, {
      runStep: async () => {
        calls += 1;
        return "complete";
      },
    });
    for (const handler of handlers.get("session_start") ?? []) handler({}, { cwd: process.cwd() });

    request(harness.bus, "reload", "spawn", { workflow: workflow([{ prompt: "once" }]) });
    await waitFor(() => calls === 1);
    expect(harness.bus.emitted.filter(({ topic }) => topic.endsWith(":reload"))).toHaveLength(1);
  });
});
