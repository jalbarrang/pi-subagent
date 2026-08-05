/** Isolated, prompt-native Pi subagent engine. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { capPreviousOutput, getFinalText, getPromptError } from "./agent-result-utils.js";
import { runPrompt } from "./agent-runner.js";
import {
  createBtwFailureData,
  createBtwResultData,
  deriveBtwTitle,
  type BtwResultData,
} from "./by-the-way.js";
import type { PromptResult, PromptRun, UsageStats } from "./agent-runner-types.js";
import { emptyUsage } from "./spawn-utils.js";
import { isAgentLeafEnvironment } from "./leaf-policy.js";
import { registerWorkflowRpc } from "./workflow-rpc.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_BTW_RUNS = 4;

const PromptItem = Type.Object({
  prompt: Type.String({ description: "Complete prompt text for the isolated child" }),
  label: Type.Optional(
    Type.String({ description: "Inert display label; it never selects instructions or defaults" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override" })),
  thinking: Type.Optional(Type.String({ description: "Reasoning level override" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit Pi tool allowlist" })),
  cwd: Type.Optional(Type.String({ description: "Child working directory override" })),
});

const SubagentParams = Type.Object({
  prompt: Type.Optional(Type.String({ description: "Complete prompt text for one child" })),
  label: Type.Optional(Type.String({ description: "Inert display label" })),
  tasks: Type.Optional(
    Type.Array(PromptItem, {
      description: "Independent prompt-native runs to execute in parallel",
    }),
  ),
  chain: Type.Optional(
    Type.Array(PromptItem, {
      description: "Sequential prompt-native runs; {previous} receives the capped raw prior output",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Default model for the run or child items" })),
  thinking: Type.Optional(
    Type.String({ description: "Default reasoning level for the run or child items" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Default explicit Pi tool allowlist for the run or child items",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Default child working directory" })),
});

type SubagentDetails = { mode: "single" | "parallel" | "chain"; results: PromptResult[] };
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function finalOutput(messages: Message[]): string {
  return getFinalText(
    {
      label: undefined,
      prompt: "",
      exitCode: 0,
      messages,
      stderr: "",
      usage: emptyUsage(),
    },
    "",
  );
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${usage.input}`);
  if (usage.output) parts.push(`↓${usage.output}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}

function validPrompt(prompt: string | undefined): prompt is string {
  return typeof prompt === "string" && prompt.trim().length > 0;
}

function mergeRun(item: PromptRun, defaults: PromptRun): PromptRun {
  return {
    prompt: item.prompt,
    label: item.label,
    cwd: item.cwd ?? defaults.cwd,
    model: item.model ?? defaults.model,
    thinking: item.thinking ?? defaults.thinking,
    tools: item.tools ?? defaults.tools,
  };
}

function displayLabel(result: PromptResult, fallback: string): string {
  return result.label || fallback;
}

export interface SubagentExtensionDependencies {
  runPrompt?: typeof runPrompt;
}

export function registerSubagentExtension(
  pi: ExtensionAPI,
  { runPrompt: promptRunner = runPrompt }: SubagentExtensionDependencies = {},
): void {
  if (isAgentLeafEnvironment()) return;
  registerWorkflowRpc(pi);

  let closed = false;
  let nextBtwId = 1;
  const activeBtwRuns = new Map<string, AbortController>();

  const settleBtw = (id: string, ctx: ExtensionCommandContext, data: BtwResultData) => {
    if (!activeBtwRuns.delete(id) || closed) return;
    pi.appendEntry("btw-result", data);
    ctx.ui.notify(
      data.status === "completed"
        ? `By the way complete: ${data.title}`
        : `By the way failed: ${data.title}`,
      data.status === "completed" ? "info" : "error",
    );
  };

  pi.registerEntryRenderer<BtwResultData>("btw-result", (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return new Text(theme.fg("error", "Invalid by-the-way result"), 0, 0);
    const output = data.error ?? data.answer;
    const container = new Container();
    container.addChild(
      new Text(
        `${data.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${theme.fg("toolTitle", theme.bold(`btw: ${data.title}`))}`,
        0,
        0,
      ),
    );
    if (expanded) {
      container.addChild(new Text(theme.fg("muted", "Question"), 0, 0));
      container.addChild(new Text(theme.fg("dim", data.prompt), 0, 0));
      container.addChild(new Text(theme.fg("muted", data.error ? "Error" : "Answer"), 0, 0));
      container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
    } else {
      container.addChild(
        new Text(
          theme.fg(data.error ? "error" : "toolOutput", output.split("\n").slice(0, 3).join("\n")),
          0,
          0,
        ),
      );
    }
    return container;
  });

  pi.registerCommand("btw", {
    description: "Ask a one-off side question without adding its result to the model context",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/btw is available only in the TUI.", "warning");
        return;
      }
      const question =
        args.trim() || (await ctx.ui.input("by the way", "Ask a one-off question…"))?.trim();
      if (!question || closed) return;
      if (activeBtwRuns.size >= MAX_BTW_RUNS) {
        ctx.ui.notify(`Only ${MAX_BTW_RUNS} /btw questions can run at once.`, "warning");
        return;
      }

      const id = `btw-${nextBtwId++}`;
      const title = deriveBtwTitle(question);
      const controller = new AbortController();
      activeBtwRuns.set(id, controller);
      const run: PromptRun = {
        prompt: question,
        label: title,
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: pi.getThinkingLevel(),
      };
      void promptRunner(run, { cwd: ctx.cwd, signal: controller.signal }).then(
        (result) => settleBtw(id, ctx, createBtwResultData(id, title, result)),
        (error: unknown) => settleBtw(id, ctx, createBtwFailureData(id, title, question, error)),
      );
    },
  });

  pi.on("session_shutdown", () => {
    closed = true;
    for (const controller of activeBtwRuns.values()) controller.abort();
    activeBtwRuns.clear();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run complete caller-provided prompts in isolated Pi subprocesses. Use exactly one mode: prompt, tasks, or chain.",
    promptGuidelines: [
      "Supply the complete child prompt. This tool does not discover named agents or add instructions.",
      "Use parallel mode only for independent work; use chain for ordered prompt handoffs.",
      "Review edits and important claims in the parent context.",
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const defaults: PromptRun = {
        prompt: "",
        model: params.model,
        thinking: params.thinking,
        tools: params.tools,
        cwd: params.cwd,
      };
      const hasSingle = params.prompt !== undefined;
      const hasTasks = params.tasks !== undefined;
      const hasChain = params.chain !== undefined;
      const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
      const details = (
        mode: SubagentDetails["mode"],
        results: PromptResult[] = [],
      ): SubagentDetails => ({ mode, results });
      if (modeCount !== 1)
        throw new Error("Invalid parameters. Provide exactly one of prompt, tasks, or chain.");
      const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const prompts = hasSingle
        ? [params.prompt]
        : (params.tasks ?? params.chain ?? []).map((item) => item.prompt);
      if (prompts.length === 0 || prompts.some((prompt) => !validPrompt(prompt)))
        throw new Error("Every selected mode must contain a non-empty prompt.");

      const runOne = async (
        run: PromptRun,
        step: number | undefined,
        update?: OnUpdateCallback,
      ): Promise<PromptResult> => {
        const result = await promptRunner(run, {
          cwd: ctx.cwd,
          signal,
          phaseName: step === undefined ? "single" : `step-${step}`,
          onUpdate: (_phase, _label, partial) =>
            update?.({
              content: [{ type: "text", text: finalOutput(partial.messages) || "(running...)" }],
              details: details(mode, [{ ...partial, step }]),
            }),
        });
        return { ...result, step };
      };

      if (hasSingle) {
        const run = mergeRun({ prompt: params.prompt!, label: params.label }, defaults);
        if (ctx.hasUI)
          ctx.ui.setWorkingMessage(
            `Running ${run.label ?? "subagent"}${run.model ? ` · ${run.model}` : ""}`,
          );
        const result = await runOne(run, undefined, onUpdate);
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        const error = getPromptError(result);
        return {
          content: [
            {
              type: "text",
              text: error ? `Subagent failed: ${error}` : finalOutput(result.messages),
            },
          ],
          details: details("single", [result]),
        };
      }

      if (hasChain) {
        const results: PromptResult[] = [];
        let previous = "";
        for (const [index, item] of params.chain!.entries()) {
          const run = mergeRun(
            { ...item, prompt: item.prompt.replace(/\{previous\}/g, previous) },
            defaults,
          );
          if (ctx.hasUI)
            ctx.ui.setWorkingMessage(
              `Chain ${index + 1}/${params.chain!.length}: ${run.label ?? "subagent"}${run.model ? ` · ${run.model}` : ""}`,
            );
          const result = await runOne(
            run,
            index + 1,
            onUpdate
              ? (partial) =>
                  onUpdate({
                    content: partial.content,
                    details: details("chain", [...results, ...partial.details!.results]),
                  })
              : undefined,
          );
          results.push(result);
          const error = getPromptError(result);
          if (error) {
            if (ctx.hasUI) ctx.ui.setWorkingMessage();
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${index + 1} (${displayLabel(result, "subagent")}): ${error}`,
                },
              ],
              details: details("chain", results),
            };
          }
          previous = capPreviousOutput(finalOutput(result.messages));
        }
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        return {
          content: [{ type: "text", text: finalOutput(results.at(-1)!.messages) }],
          details: details("chain", results),
        };
      }

      const taskItems = params.tasks!;
      if (taskItems.length > MAX_PARALLEL_TASKS)
        throw new Error(
          `Too many parallel tasks (${taskItems.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        );
      const running: PromptResult[] = taskItems.map((item) => ({
        label: item.label,
        prompt: item.prompt,
        model: item.model ?? defaults.model,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
      }));
      const emitProgress = () =>
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Parallel: ${running.filter((result) => result.exitCode !== -1).length}/${running.length} done...`,
            },
          ],
          details: details("parallel", [...running]),
        });
      if (ctx.hasUI) ctx.ui.setWorkingMessage(`Running ${taskItems.length} prompts in parallel`);
      const results = await mapWithConcurrencyLimit(taskItems, async (item, index) => {
        const result = await runOne(mergeRun(item, defaults), undefined, (partial) => {
          running[index] = partial.details!.results[0]!;
          emitProgress();
        });
        running[index] = result;
        emitProgress();
        return result;
      });
      if (ctx.hasUI) ctx.ui.setWorkingMessage();
      const successCount = results.filter((result) => !getPromptError(result)).length;
      const summary = results
        .map(
          (result, index) =>
            `[${displayLabel(result, `prompt-${index + 1}`)}] ${getPromptError(result) ? "failed" : "completed"}: ${getPromptError(result) ?? finalOutput(result.messages)}`,
        )
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summary}`,
          },
        ],
        details: details("parallel", results),
      };
    },
    renderCall(args, theme) {
      const items = args.chain ?? args.tasks;
      if (items?.length)
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `${args.chain ? "chain" : "parallel"} (${items.length})`)}`,
          0,
          0,
        );
      const preview = args.prompt ? args.prompt.slice(0, 80) : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.label ?? "prompt")}\n  ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length)
        return new Text(
          result.content[0]?.type === "text" ? result.content[0].text : "(no output)",
          0,
          0,
        );
      const container = new Container();
      for (const [index, run] of details.results.entries()) {
        const error = getPromptError(run);
        const label = displayLabel(run, `prompt-${index + 1}`);
        container.addChild(
          new Text(
            `${error ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(label))}${run.model ? theme.fg("dim", ` · ${run.model}`) : ""}`,
            0,
            0,
          ),
        );
        if (expanded) {
          container.addChild(new Text(theme.fg("muted", "Prompt"), 0, 0));
          container.addChild(new Text(theme.fg("dim", run.prompt), 0, 0));
          container.addChild(
            new Text(theme.fg("muted", error ? `Error: ${error}` : "Output"), 0, 0),
          );
          container.addChild(
            new Markdown(
              (error ? error : finalOutput(run.messages)).trim(),
              0,
              0,
              getMarkdownTheme(),
            ),
          );
        } else
          container.addChild(
            new Text(
              theme.fg(
                error ? "error" : "toolOutput",
                (error ? error : finalOutput(run.messages)).split("\n").slice(0, 3).join("\n"),
              ),
              0,
              0,
            ),
          );
        const usage = formatUsage(run.usage, run.model);
        if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
        if (index < details.results.length - 1) container.addChild(new Spacer(1));
      }
      return container;
    },
  });
}

export default function subagentExtension(pi: ExtensionAPI): void {
  registerSubagentExtension(pi);
}
