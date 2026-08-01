import { describe, expect, it } from "bun:test";

type Listener = (payload: unknown) => void;

class FakeBus {
  readonly emitted: Array<{ topic: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Listener[]>();
  on(topic: string, listener: Listener): () => void {
    const listeners = this.listeners.get(topic) ?? [];
    listeners.push(listener);
    this.listeners.set(topic, listeners);
    return () => {};
  }
  emit(topic: string, payload: unknown): void {
    this.emitted.push({ topic, payload });
    for (const listener of this.listeners.get(topic) ?? []) listener(payload);
  }
  reply(requestId: string): { success: boolean; error?: { message: string } } {
    const event = this.emitted.findLast(({ topic }) => topic.endsWith(`:${requestId}`));
    if (!event) throw new Error(`Missing reply for ${requestId}.`);
    return event.payload as { success: boolean; error?: { message: string } };
  }
}

const { registerWorkflowRpc, SUBAGENT_RPC_REQUEST_EVENT } =
  await import("../extensions/subagent/workflow-rpc.js");

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for workflow completion.");
}

describe("prompt-native workflow forwarding", () => {
  it("forwards fully rendered prompts and explicit controls without discovery", async () => {
    const bus = new FakeBus();
    let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
    const received: Array<Record<string, unknown>> = [];
    registerWorkflowRpc(
      {
        events: bus,
        on(event: string, listener: (event: unknown, context: unknown) => void) {
          if (event === "session_start") sessionStart = listener;
        },
      } as never,
      {
        runStep: async (_ctx, _workflow, step, prompt) => {
          received.push({ ...step, prompt });
          return "first output";
        },
      },
    );
    sessionStart?.({}, { cwd: process.cwd() });
    bus.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 2,
      requestId: "forward",
      method: "spawn",
      params: {
        workflow: {
          name: "forward",
          task: "workflow task",
          chain: [
            {
              label: "first",
              prompt: "Do {task}",
              model: "openai/test",
              thinking: "low",
              tools: ["read"],
              cwd: "/tmp",
            },
            { label: "second", prompt: "Use {previous}" },
          ],
        },
      },
    });
    await waitFor(() => received.length === 2);
    expect(received[0]).toMatchObject({
      label: "first",
      prompt: "Do workflow task",
      model: "openai/test",
      thinking: "low",
      tools: ["read"],
      cwd: "/tmp",
    });
    expect(received[1]).toMatchObject({ label: "second", prompt: "Use first output" });
    expect(JSON.stringify(received)).not.toContain("agent");
  });

  it("rejects malformed steps and concurrency above the engine limit", () => {
    const bus = new FakeBus();
    let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
    registerWorkflowRpc({
      events: bus,
      on(event: string, listener: (event: unknown, context: unknown) => void) {
        if (event === "session_start") sessionStart = listener;
      },
    } as never);
    sessionStart?.({}, { cwd: process.cwd() });

    for (const [requestId, step] of [
      ["malformed", { label: "missing prompt" }],
      ["concurrency", { parallel: [{ prompt: "work" }], concurrency: 5 }],
    ] as const) {
      bus.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: 2,
        requestId,
        method: "spawn",
        params: {
          workflow: { name: "invalid", task: "reject", chain: [step] },
        },
      });
      expect(bus.reply(requestId)).toMatchObject({
        success: false,
        error: { message: expect.stringContaining("bounded maximum") },
      });
    }
  });
});
