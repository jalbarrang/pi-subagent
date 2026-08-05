import { describe, expect, it } from "bun:test";
import {
  MAX_PREVIOUS_OUTPUT_BYTES,
  PREVIOUS_OUTPUT_TRUNCATION_MARKER,
  capPreviousOutput,
  getFinalText,
  getPromptError,
} from "../extensions/subagent/agent-result-utils.js";
import subagentExtension from "../extensions/subagent/index.js";

describe("prompt-native contract", () => {
  it("caps raw previous output with a neutral marker at a valid UTF-8 boundary", () => {
    const capped = capPreviousOutput(`${"x".repeat(MAX_PREVIOUS_OUTPUT_BYTES - 1)}🦖`);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(MAX_PREVIOUS_OUTPUT_BYTES);
    expect(capped).toEndWith(PREVIOUS_OUTPUT_TRUNCATION_MARKER);
    expect(capped).not.toContain("�");
  });

  it("returns every text segment from the final assistant message", () => {
    const output = getFinalText({
      prompt: "fixture",
      exitCode: 0,
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
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: " second" },
          ],
        } as never,
      ],
    });
    expect(output).toBe("first second");
  });

  it("treats provider error stop reasons as failed prompt runs", () => {
    expect(
      getPromptError({
        prompt: "fixture",
        exitCode: 0,
        stderr: "provider failed",
        stopReason: "error",
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
      }),
    ).toBe("provider failed");
  });

  it("rejects missing and empty prompt modes before any child run", async () => {
    const previousLeaf = process.env.PI_AGENT_LEAF;
    delete process.env.PI_AGENT_LEAF;
    try {
      let tool:
        | {
            execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
          }
        | undefined;
      subagentExtension({
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
      } as never);
      if (!tool) throw new Error("subagent tool was not registered");
      const context = { cwd: process.cwd(), hasUI: false };
      await expect(tool.execute("", {}, undefined, undefined, context)).rejects.toThrow(
        "exactly one",
      );
      await expect(
        tool.execute("", { prompt: "   " }, undefined, undefined, context),
      ).rejects.toThrow("non-empty prompt");
      await expect(
        tool.execute("", { tasks: [{ prompt: "" }] }, undefined, undefined, context),
      ).rejects.toThrow("non-empty prompt");
      await expect(
        tool.execute(
          "",
          { prompt: "", tasks: [{ prompt: "valid" }] },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toThrow("exactly one");
    } finally {
      if (previousLeaf === undefined) delete process.env.PI_AGENT_LEAF;
      else process.env.PI_AGENT_LEAF = previousLeaf;
    }
  });
});
