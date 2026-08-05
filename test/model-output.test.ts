import { describe, expect, it } from "bun:test";
import {
  capModelOutput,
  MAX_MODEL_OUTPUT_BYTES,
  MAX_MODEL_OUTPUT_LINES,
  MODEL_OUTPUT_TRUNCATION_MARKER,
} from "../extensions/subagent/agent-result-utils.js";
import type { PromptResult, PromptRun } from "../extensions/subagent/agent-runner-types.js";
import { ExecutionCoordinator } from "../extensions/subagent/execution-coordinator.js";
import { registerSubagentExtension } from "../extensions/subagent/index.js";

function result(
  prompt: string,
  output: string,
  overrides: Partial<PromptResult> = {},
): PromptResult {
  return {
    prompt,
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: output }] } as never],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
    ...overrides,
  };
}

function outputText(value: { content: Array<{ type: string; text: string }> }): string {
  return value.content[0]!.text;
}

function expectBound(output: string): void {
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_MODEL_OUTPUT_BYTES);
  expect(output.split("\n").length).toBeLessThanOrEqual(MAX_MODEL_OUTPUT_LINES);
  expect(output).toEndWith(MODEL_OUTPUT_TRUNCATION_MARKER);
  expect(output).not.toContain("�");
}

function toolHarness(
  runner: (run: PromptRun, options: Record<string, unknown>) => Promise<PromptResult>,
): { execute: (...args: any[]) => Promise<any> } {
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
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
      events: { on() {}, emit() {} },
      on() {},
    } as never,
    { runPrompt: runner as never, coordinator: new ExecutionCoordinator() },
  );
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

describe("model-visible output policy", () => {
  it("uses line-safe UTF-8 truncation with an explicit marker", () => {
    const capped = capModelOutput(
      `${"line\n".repeat(MAX_MODEL_OUTPUT_LINES)}${"🦖".repeat(MAX_MODEL_OUTPUT_BYTES)}`,
    );
    expect(capped.truncated).toBe(true);
    expectBound(capped.content);
  });

  it("bounds single final, error, and progress content without truncating raw details", async () => {
    const large = "🦖".repeat(MAX_MODEL_OUTPUT_BYTES);
    const updates: string[] = [];
    const tool = toolHarness(async (run, options) => {
      const partial = result(run.prompt, large);
      (options.onUpdate as ((...args: any[]) => void) | undefined)?.("single", run.label, partial);
      return result(run.prompt, large);
    });
    const context = { cwd: process.cwd(), hasUI: false };
    const completed = await tool.execute(
      "",
      { prompt: "large" },
      undefined,
      (update: any) => {
        updates.push(outputText(update));
      },
      context,
    );

    expectBound(outputText(completed));
    expectBound(updates[0]!);
    expect((completed.details.results[0].messages[0].content[0].text as string).length).toBe(
      large.length,
    );

    const failedTool = toolHarness(async (run) =>
      result(run.prompt, large, { exitCode: 1, stderr: large }),
    );
    const failed = await failedTool.execute(
      "",
      { prompt: "failure" },
      undefined,
      undefined,
      context,
    );
    expectBound(outputText(failed));
    expect((failed.details.results[0].stderr as string).length).toBe(large.length);
  });

  it("bounds chain failures and both per-child and aggregate parallel summaries", async () => {
    const large = "x".repeat(MAX_MODEL_OUTPUT_BYTES);
    const context = { cwd: process.cwd(), hasUI: false };
    const chainTool = toolHarness(async (run) =>
      result(run.prompt, large, { exitCode: 1, stderr: large }),
    );
    const chain = await chainTool.execute(
      "",
      { chain: [{ prompt: "first", label: "first" }] },
      undefined,
      undefined,
      context,
    );
    expectBound(outputText(chain));
    expect(chain.details.results[0].stderr).toBe(large);

    const parallelTool = toolHarness(async (run) => result(run.prompt, large));
    const parallel = await parallelTool.execute(
      "",
      { tasks: Array.from({ length: 8 }, (_, index) => ({ prompt: `prompt-${index}` })) },
      undefined,
      undefined,
      context,
    );
    expectBound(outputText(parallel));
    expect(outputText(parallel)).toContain(MODEL_OUTPUT_TRUNCATION_MARKER);
    expect(parallel.details.results).toHaveLength(8);
    expect(parallel.details.results[0].messages[0].content[0].text).toBe(large);
  });
});
