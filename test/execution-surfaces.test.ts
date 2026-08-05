import { describe, expect, it } from "bun:test";
import type { PromptResult, PromptRun } from "../extensions/subagent/agent-runner-types.js";
import { ExecutionCoordinator } from "../extensions/subagent/execution-coordinator.js";
import { registerSubagentExtension } from "../extensions/subagent/index.js";
import { SUBAGENT_RPC_REQUEST_EVENT } from "../extensions/subagent/workflow-rpc.js";

type Listener = (payload: unknown) => void;

class Bus {
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
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function promptResult(prompt: string): PromptResult {
  return {
    prompt,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

describe("shared execution surfaces", () => {
  it("shares permits across direct tools, workflow children, and /btw shutdown races", async () => {
    const coordinator = new ExecutionCoordinator(3);
    const bus = new Bus();
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
    const notifications: string[] = [];
    const entries: unknown[] = [];
    let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
    const calls: Array<{ run: PromptRun; signal?: AbortSignal }> = [];
    const runner = (run: PromptRun, options: { signal?: AbortSignal }) =>
      new Promise<PromptResult>((resolve, reject) => {
        calls.push({ run, signal: options.signal });
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        void resolve;
      });

    registerSubagentExtension(
      {
        events: bus,
        registerTool(value: typeof tool) {
          tool = value;
        },
        registerCommand(name: string, value: { handler(args: string, ctx: any): Promise<void> }) {
          commands.set(name, value);
        },
        registerEntryRenderer() {},
        appendEntry(_type: string, data: unknown) {
          entries.push(data);
        },
        getThinkingLevel() {
          return "high";
        },
        on(event: string, handler: (...args: any[]) => void) {
          const eventHandlers = handlers.get(event) ?? [];
          eventHandlers.push(handler);
          handlers.set(event, eventHandlers);
        },
      } as never,
      {
        coordinator,
        runPrompt: runner as never,
        workflowRunStep: async (_ctx, _workflow, step, prompt, signal) => {
          await runner({ prompt, label: step.label }, { signal });
          return "";
        },
      },
    );
    if (!tool) throw new Error("subagent tool was not registered");
    const context = { cwd: process.cwd(), hasUI: false };
    for (const handler of handlers.get("session_start") ?? []) handler({}, context);

    const directController = new AbortController();
    const direct = tool.execute(
      "",
      { prompt: "direct" },
      directController.signal,
      undefined,
      context,
    );
    await flush();
    bus.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 2,
      requestId: "workflow",
      method: "spawn",
      params: { workflow: { name: "workflow", task: "task", chain: [{ prompt: "workflow" }] } },
    });
    await flush();
    expect(calls.map(({ run }) => run.prompt)).toEqual(["direct", "workflow"]);
    expect(coordinator.activeCount).toBe(2);

    const btw = commands.get("btw");
    if (!btw) throw new Error("/btw was not registered");
    const btwContext = {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    };
    await btw.handler("side question", btwContext);
    expect(calls.map(({ run }) => run.prompt)).toEqual(["direct", "workflow", "side question"]);
    expect(coordinator.activeCount).toBe(3);
    await btw.handler("second side question", btwContext);
    expect(notifications).toEqual([
      "All subagent execution slots are busy. Try /btw again shortly.",
    ]);

    const queuedController = new AbortController();
    const queued = tool.execute(
      "",
      { prompt: "queued" },
      queuedController.signal,
      undefined,
      context,
    );
    await flush();
    expect(coordinator.queuedCount).toBe(1);
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    const queuedAtShutdown = tool.execute(
      "",
      { prompt: "queued at shutdown" },
      undefined,
      undefined,
      context,
    );
    await flush();
    expect(coordinator.queuedCount).toBe(1);
    for (const handler of handlers.get("session_shutdown") ?? []) handler();
    await expect(queuedAtShutdown).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(calls[1]!.signal?.aborted).toBe(true);
    expect(calls[2]!.signal?.aborted).toBe(true);
    expect(entries).toEqual([]);
    expect(coordinator.activeCount).toBe(1);

    directController.abort();
    await expect(direct).rejects.toThrow("aborted");
    expect(coordinator.activeCount).toBe(0);
  });
});
