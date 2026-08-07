import type { PromptResult, PromptRun } from "./agent-runner-types.js";
import { dispatchSubagent } from "./dispatch.js";
import {
  executionCoordinator,
  type ExecutionCoordinator,
  type ExecutionLease,
} from "./execution-coordinator.js";
import { emptyUsage, type ToolExecutionStartEvent } from "./spawn-utils.js";

export type OnPhaseUpdate = (
  phaseName: string,
  label: string | undefined,
  result: PromptResult,
) => void;

export interface RunPromptOptions {
  cwd: string;
  onUpdate?: OnPhaseUpdate;
  onToolExecutionStart?: (event: ToolExecutionStartEvent) => void;
  phaseName?: string;
  signal?: AbortSignal;
  coordinator?: ExecutionCoordinator;
  lease?: ExecutionLease;
}

/** The one backend-neutral engine seam: a complete prompt plus explicit controls. */
export async function runPrompt(run: PromptRun, options: RunPromptOptions): Promise<PromptResult> {
  const result: PromptResult = {
    label: run.label,
    prompt: run.prompt,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: run.model,
  };
  const lease =
    options.lease ?? (await (options.coordinator ?? executionCoordinator).acquire(options.signal));
  try {
    let spawned: Awaited<ReturnType<typeof dispatchSubagent>> | undefined;
    spawned = await dispatchSubagent({
      cwd: run.cwd ?? options.cwd,
      prompt: run.prompt,
      label: run.label,
      model: run.model,
      thinking: run.thinking,
      tools: run.tools,
      backend: run.backend,
      signal: options.signal,
      onMessage: (message) => {
        if (spawned) {
          result.messages = spawned.messages;
          result.usage = spawned.usage;
          result.model = spawned.model ?? result.model;
          result.stopReason = spawned.stopReason;
          result.errorMessage = spawned.errorMessage;
        } else {
          result.messages = [...result.messages, message];
        }
        options.onUpdate?.(options.phaseName ?? "unknown", run.label, { ...result });
      },
      onToolResult: (message) => {
        result.messages = spawned ? spawned.messages : [...result.messages, message];
        options.onUpdate?.(options.phaseName ?? "unknown", run.label, { ...result });
      },
      onToolExecutionStart: options.onToolExecutionStart,
    });
    result.exitCode = spawned.exitCode;
    result.messages = spawned.messages;
    result.stderr = spawned.stderr;
    result.usage = spawned.usage;
    result.model = spawned.model ?? result.model;
    result.stopReason = spawned.stopReason;
    result.errorMessage = spawned.errorMessage;
    return result;
  } finally {
    lease.release();
  }
}
