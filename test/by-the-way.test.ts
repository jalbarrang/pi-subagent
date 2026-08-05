import { describe, expect, it } from "bun:test";
import type { PromptResult, PromptRun } from "../extensions/subagent/agent-runner-types.js";
import {
  BTW_OUTPUT_TRUNCATION_MARKER,
  MAX_BTW_OUTPUT_BYTES,
  MAX_BTW_OUTPUT_LINES,
  capBtwOutput,
  deriveBtwTitle,
} from "../extensions/subagent/by-the-way.js";
import { registerSubagentExtension } from "../extensions/subagent/index.js";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
type RegisteredCommand = {
  handler(args: string, ctx: unknown): Promise<void>;
  description?: string;
};
type PromptRunner = (
  run: PromptRun,
  options: { cwd: string; signal?: AbortSignal },
) => Promise<PromptResult>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function promptResult(
  prompt: string,
  output = "answer",
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(promptRunner: PromptRunner) {
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, () => void>();
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  registerSubagentExtension(
    {
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      registerTool() {},
      registerEntryRenderer() {},
      appendEntry(type: string, data: Record<string, unknown>) {
        entries.push({ type, data });
      },
      getThinkingLevel() {
        return "high";
      },
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      sendMessage() {
        throw new Error("/btw must not send a parent-model message");
      },
    } as never,
    { runPrompt: promptRunner as never },
  );
  const command = commands.get("btw");
  if (!command) throw new Error("/btw was not registered");
  const context = {
    cwd: "/fixture",
    mode: "tui",
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-terra" },
    ui: {
      input: async () => undefined,
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };
  return { command, context, entries, handlers, notifications };
}

describe("/btw helpers", () => {
  it("derives a normalized, Unicode-safe title", () => {
    expect(deriveBtwTitle("\n  What\t is this?  \nsecond line")).toBe("What is this?");
    expect(deriveBtwTitle("  \n\t ")).toBe("by the way");
    expect(deriveBtwTitle("🦖".repeat(61))).toBe(`${"🦖".repeat(59)}…`);
  });

  it("bounds result output by bytes and lines with an explicit marker", () => {
    const lineBounded = capBtwOutput(
      Array.from({ length: 601 }, (_, index) => `line-${index}`).join("\n"),
    );
    expect(lineBounded.truncated).toBe(true);
    expect(lineBounded.content).toEndWith(BTW_OUTPUT_TRUNCATION_MARKER);
    expect(lineBounded.content.split("\n")).toHaveLength(MAX_BTW_OUTPUT_LINES);

    const byteBounded = capBtwOutput("🦖".repeat(MAX_BTW_OUTPUT_BYTES));
    expect(byteBounded.truncated).toBe(true);
    expect(Buffer.byteLength(byteBounded.content)).toBeLessThanOrEqual(MAX_BTW_OUTPUT_BYTES);
    expect(byteBounded.content).not.toContain("�");
  });
});

describe("/btw command", () => {
  it("registers the TUI-only command and preserves the leaf registration guard", async () => {
    const previousLeaf = process.env.PI_AGENT_LEAF;
    delete process.env.PI_AGENT_LEAF;
    try {
      const harness = createHarness(async (run) => promptResult(run.prompt));
      expect(harness.command.description).toContain("one-off side question");
      harness.context.mode = "rpc";
      await harness.command.handler("question", harness.context);
      expect(harness.notifications).toEqual([
        { message: "/btw is available only in the TUI.", type: "warning" },
      ]);
    } finally {
      if (previousLeaf === undefined) delete process.env.PI_AGENT_LEAF;
      else process.env.PI_AGENT_LEAF = previousLeaf;
    }
  });

  it("prompts for missing input and ignores cancelled or blank questions", async () => {
    const received: PromptRun[] = [];
    const harness = createHarness(async (run) => {
      received.push(run);
      return promptResult(run.prompt);
    });
    await harness.command.handler("", harness.context);
    harness.context.ui.input = async () => "   ";
    await harness.command.handler("", harness.context);
    harness.context.ui.input = async () => "  entered question  ";
    await harness.command.handler("", harness.context);
    expect(received).toEqual([expect.objectContaining({ prompt: "entered question" })]);
  });

  it("starts an exact prompt-native run and returns before it settles", async () => {
    const child = deferred<PromptResult>();
    const calls: Array<{ run: PromptRun; options: { cwd: string; signal?: AbortSignal } }> = [];
    const harness = createHarness((run, options) => {
      calls.push({ run, options });
      return child.promise;
    });
    await harness.command.handler("  Keep this exact.  ", harness.context);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.run).toEqual({
      prompt: "Keep this exact.",
      label: "Keep this exact.",
      cwd: "/fixture",
      model: "openai-codex/gpt-5.6-terra",
      thinking: "high",
    });
    expect(calls[0]?.options.cwd).toBe("/fixture");
    expect(calls[0]?.options.signal?.aborted).toBe(false);
    expect(harness.entries).toHaveLength(0);

    child.resolve(promptResult("Keep this exact.", "settled answer"));
    await flush();
    expect(harness.entries).toEqual([
      expect.objectContaining({
        type: "btw-result",
        data: expect.objectContaining({
          id: "btw-1",
          status: "completed",
          prompt: "Keep this exact.",
          answer: "settled answer",
        }),
      }),
    ]);
    expect(harness.notifications).toEqual([
      { message: "By the way complete: Keep this exact.", type: "info" },
    ]);
  });

  it("settles failures and unexpected rejections once without leaking them", async () => {
    const failedChild = deferred<PromptResult>();
    const rejectedChild = deferred<PromptResult>();
    const children = [failedChild, rejectedChild];
    const harness = createHarness(() => children.shift()!.promise);
    await harness.command.handler("failed run", harness.context);
    failedChild.resolve(
      promptResult("failed run", "provider output", { exitCode: 1, stderr: "child failed" }),
    );
    await flush();
    expect(harness.entries[0]?.data).toMatchObject({ status: "failed", error: "child failed" });

    await harness.command.handler("rejected run", harness.context);
    rejectedChild.reject(new Error());
    await flush();
    expect(harness.entries).toHaveLength(2);
    expect(harness.entries[1]?.data).toMatchObject({ status: "failed", error: "(no output)" });
  });

  it("limits concurrent side questions and frees the slot after settlement", async () => {
    const children = Array.from({ length: 5 }, () => deferred<PromptResult>());
    let calls = 0;
    const harness = createHarness((_run) => children[calls++]!.promise);
    for (let index = 0; index < 4; index++)
      await harness.command.handler(`question ${index}`, harness.context);
    await harness.command.handler("fifth", harness.context);
    expect(calls).toBe(4);
    expect(harness.notifications).toEqual([
      { message: "Only 4 /btw questions can run at once.", type: "warning" },
    ]);

    children[0]!.resolve(promptResult("question 0"));
    await flush();
    await harness.command.handler("replacement", harness.context);
    expect(calls).toBe(5);
  });

  it("aborts active children and suppresses late settlement during shutdown", async () => {
    const child = deferred<PromptResult>();
    let signal: AbortSignal | undefined;
    const harness = createHarness((run, options) => {
      signal = options.signal;
      return child.promise.then(() => promptResult(run.prompt));
    });
    await harness.command.handler("shutdown race", harness.context);
    harness.handlers.get("session_shutdown")?.();
    expect(signal?.aborted).toBe(true);

    child.resolve(promptResult("shutdown race"));
    await flush();
    expect(harness.entries).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
  });
});
