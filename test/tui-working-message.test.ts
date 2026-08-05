import { describe, expect, it } from "bun:test";
import type { PromptResult } from "../extensions/subagent/agent-runner-types.js";
import { ExecutionCoordinator } from "../extensions/subagent/execution-coordinator.js";
import { registerSubagentExtension } from "../extensions/subagent/index.js";

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

function harness(coordinator: ExecutionCoordinator): {
  execute: (...args: any[]) => Promise<unknown>;
} {
  let tool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
  registerSubagentExtension(
    {
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      registerEntryRenderer() {},
      getThinkingLevel() {
        return "high";
      },
      on() {},
      events: { on() {}, emit() {} },
    } as never,
    { coordinator, runPrompt: async (run) => promptResult(run.prompt) },
  );
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

describe("subagent TUI working messages", () => {
  for (const [name, params] of [
    ["single", { prompt: "one" }],
    ["chain", { chain: [{ prompt: "one" }] }],
    ["parallel", { tasks: [{ prompt: "one" }] }],
  ] as const) {
    it(`clears the ${name} working message when aborting while queued`, async () => {
      const coordinator = new ExecutionCoordinator(1);
      const occupied = coordinator.tryAcquire();
      if (!occupied) throw new Error("failed to occupy the permit");
      const tool = harness(coordinator);
      const controller = new AbortController();
      const messages: Array<string | undefined> = [];
      const context = {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          setWorkingMessage(message?: string) {
            messages.push(message);
          },
        },
      };

      const execution = tool.execute("", params, controller.signal, undefined, context);
      await Promise.resolve();
      controller.abort();
      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      expect(messages[0]).toEqual(expect.any(String));
      expect(messages.at(-1)).toBeUndefined();
      occupied.release();
    });
  }
});
