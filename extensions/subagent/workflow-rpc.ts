/** Prompt-native v2 workflow RPC bridge for reviewed background orchestration. */

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  capPreviousOutput,
  capSnapshotOutput,
  getFinalText,
  getPromptError,
  MAX_WORKFLOW_SNAPSHOT_BYTES,
  MAX_WORKFLOW_SNAPSHOT_LINES,
  type TextBudget,
} from "./agent-result-utils.js";
import { runPrompt } from "./agent-runner.js";
import { isBackendName, type BackendName } from "./agent-runner-types.js";
import {
  executionCoordinator,
  type ExecutionCoordinator,
  type ExecutionLease,
} from "./execution-coordinator.js";

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v2:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v2:reply:";
const MAX_WORKFLOW_CONCURRENCY = 4;

type RpcBus = {
  on(topic: string, listener: (payload: unknown) => void): (() => void) | void;
  emit(topic: string, payload: unknown): void;
};

export interface WorkflowPromptStep {
  prompt: string;
  label?: string;
  as?: string;
  backend?: BackendName;
  model?: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
}

export interface WorkflowParallelStep {
  parallel: WorkflowPromptStep[];
  label?: string;
  concurrency?: number;
}
export interface WorkflowFanoutStep {
  expand: { from: string; path: string; item: string; maxItems: number };
  parallel: WorkflowPromptStep;
  collect: { as: string };
  label?: string;
  concurrency?: number;
}
export type WorkflowStep = WorkflowPromptStep | WorkflowParallelStep | WorkflowFanoutStep;
export interface WorkflowDefinition {
  name: string;
  description?: string;
  task: string;
  chain: WorkflowStep[];
}

interface WorkflowPhase {
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  startedAt?: string;
  finishedAt?: string;
  agents?: { done: number; total: number };
}
interface WorkflowRun {
  id: string;
  workflow: WorkflowDefinition;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  finishedAt?: string;
  phases: WorkflowPhase[];
  error?: string;
  controller: AbortController;
  runsDir?: string;
  persistence?: { writing: boolean; queued: boolean };
}
interface RpcRequest {
  version: 2;
  requestId: string;
  method: "ping" | "spawn" | "status" | "stop" | "resume";
  params?: { workflow?: WorkflowDefinition; id?: string; runsDir?: string };
}
export interface WorkflowRunSnapshot {
  id: string;
  status: WorkflowRun["status"];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  phases: WorkflowPhase[];
}

export function toSnapshot(
  run: WorkflowRun,
  budget: TextBudget = {
    bytes: MAX_WORKFLOW_SNAPSHOT_BYTES,
    lines: MAX_WORKFLOW_SNAPSHOT_LINES,
  },
): WorkflowRunSnapshot {
  const error = run.error === undefined ? undefined : capSnapshotOutput(run.error, budget);
  const phases = run.phases.map((phase) => {
    const output = phase.output === undefined ? undefined : capSnapshotOutput(phase.output, budget);
    return {
      label: phase.label,
      status: phase.status,
      ...(output === undefined ? {} : { output }),
      ...(phase.startedAt === undefined ? {} : { startedAt: phase.startedAt }),
      ...(phase.finishedAt === undefined ? {} : { finishedAt: phase.finishedAt }),
      ...(phase.agents === undefined ? {} : { agents: { ...phase.agents } }),
    };
  });
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(error === undefined ? {} : { error }),
    phases,
  };
}

function persistRun(run: WorkflowRun): void {
  if (!run.runsDir) return;
  const persistence = (run.persistence ??= { writing: false, queued: false });
  if (persistence.writing) {
    persistence.queued = true;
    return;
  }
  persistence.writing = true;
  void (async () => {
    do {
      persistence.queued = false;
      try {
        const snapshot = {
          ...toSnapshot(run),
          workflow: { name: run.workflow.name, description: run.workflow.description },
          updatedAt: new Date().toISOString(),
        };
        const runsDir = resolve(run.runsDir!);
        const destination = join(runsDir, `${run.id}.json`);
        const temporary = join(runsDir, `.${run.id}.${randomUUID()}.tmp`);
        await mkdir(runsDir, { recursive: true });
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
        await rename(temporary, destination);
      } catch {
        /* Persistence is best-effort. */
      }
    } while (persistence.queued);
    persistence.writing = false;
  })();
}

function rpcBus(pi: ExtensionAPI): RpcBus | undefined {
  const events = (pi as unknown as { events?: RpcBus }).events;
  return events && typeof events.on === "function" && typeof events.emit === "function"
    ? events
    : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function isPromptStep(step: unknown): step is WorkflowPromptStep {
  return isRecord(step) && typeof step.prompt === "string";
}
function isParallelStep(step: unknown): step is WorkflowParallelStep {
  return isRecord(step) && Array.isArray(step.parallel) && !("expand" in step);
}
function isFanoutStep(step: unknown): step is WorkflowFanoutStep {
  return (
    isRecord(step) && isRecord(step.expand) && isPromptStep(step.parallel) && isRecord(step.collect)
  );
}
function pathValue(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return value;
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (current, part) =>
        current !== null && typeof current === "object"
          ? (current as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")]
          : undefined,
      value,
    );
}
function decodedOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}
export function template(
  prompt: string,
  workflowTask: string,
  previous: string,
  outputs: Record<string, unknown>,
  item?: unknown,
): string {
  return prompt
    .replace(/\{task\}/g, workflowTask)
    .replace(/\{previous\}/g, previous)
    .replace(/\{outputs\.([A-Za-z][\w-]*)\}/g, (_match, key: string) =>
      JSON.stringify(outputs[key] ?? ""),
    )
    .replace(/\{([A-Za-z][\w-]*)\.([A-Za-z][\w-]*)\}/g, (_match, key: string, property: string) => {
      if (!item || key === "outputs") return _match;
      const value = (item as Record<string, unknown>)[property];
      return value === undefined ? _match : String(value);
    })
    .replace(/\{item\}/g, item === undefined ? "{item}" : JSON.stringify(item));
}
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = Array.from<R>({ length: values.length });
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, MAX_WORKFLOW_CONCURRENCY, values.length)) },
      async () => {
        while (next < values.length) {
          const index = next++;
          result[index] = await fn(values[index]!, index);
        }
      },
    ),
  );
  return result;
}
function stepLabel(step: WorkflowStep, index: number): string {
  return step.label ?? `Phase ${index + 1}`;
}
function validPromptStep(step: WorkflowPromptStep): boolean {
  return (
    step.prompt.trim().length > 0 && (step.backend === undefined || isBackendName(step.backend))
  );
}
function validConcurrency(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= MAX_WORKFLOW_CONCURRENCY)
  );
}
function maximumPromptRunCount(workflow: WorkflowDefinition): number | undefined {
  if (
    !isRecord(workflow) ||
    typeof workflow.name !== "string" ||
    typeof workflow.task !== "string" ||
    !Array.isArray(workflow.chain) ||
    workflow.chain.length === 0 ||
    workflow.chain.length > 32
  )
    return undefined;
  let count = 0;
  for (const step of workflow.chain) {
    if (isPromptStep(step)) {
      if (!validPromptStep(step)) return undefined;
      count++;
    } else if (isParallelStep(step)) {
      if (
        !validConcurrency(step.concurrency) ||
        step.parallel.length === 0 ||
        !step.parallel.every((child) => isPromptStep(child) && validPromptStep(child))
      )
        return undefined;
      count += step.parallel.length;
    } else if (isFanoutStep(step)) {
      if (
        !validConcurrency(step.concurrency) ||
        typeof step.expand.from !== "string" ||
        typeof step.expand.path !== "string" ||
        typeof step.expand.item !== "string" ||
        !Number.isInteger(step.expand.maxItems) ||
        (step.expand.maxItems as number) < 1 ||
        typeof step.collect.as !== "string" ||
        !validPromptStep(step.parallel)
      )
        return undefined;
      count += step.expand.maxItems as number;
    } else return undefined;
    if (count > 100) return undefined;
  }
  return count;
}

async function runPromptStep(
  ctx: ExtensionContext,
  _definition: WorkflowDefinition,
  step: WorkflowPromptStep,
  prompt: string,
  signal: AbortSignal,
  lease: ExecutionLease,
): Promise<string> {
  const result = await runPrompt(
    {
      prompt,
      label: step.label,
      backend: step.backend,
      model: step.model,
      thinking: step.thinking,
      tools: step.tools,
      cwd: step.cwd,
    },
    { cwd: ctx.cwd, signal, lease },
  );
  const error = getPromptError(result);
  if (error) throw new Error(`Prompt step "${step.label ?? "unnamed"}" failed: ${error}`);
  return getFinalText(result);
}
export interface WorkflowRpcOptions {
  coordinator?: ExecutionCoordinator;
  runStep?: typeof runPromptStep;
}

async function executeRun(
  run: WorkflowRun,
  ctx: ExtensionContext,
  runStep = runPromptStep,
  coordinator = executionCoordinator,
): Promise<void> {
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const runStepWithPermit = async (step: WorkflowPromptStep, prompt: string): Promise<string> => {
    const lease = await coordinator.acquire(run.controller.signal);
    try {
      return await runStep(ctx, run.workflow, step, prompt, run.controller.signal, lease);
    } finally {
      lease.release();
    }
  };
  let previous = "";
  try {
    for (let index = 0; index < run.workflow.chain.length; index++) {
      const step = run.workflow.chain[index]!;
      const phase = run.phases[index]!;
      phase.status = "running";
      phase.startedAt = new Date().toISOString();
      persistRun(run);
      if (isPromptStep(step)) {
        phase.agents = { done: 0, total: 1 };
        previous = await runStepWithPermit(
          step,
          template(step.prompt, run.workflow.task, capPreviousOutput(previous), outputs),
        );
        phase.agents.done += 1;
        if (step.as) outputs[step.as] = decodedOutput(previous);
        persistRun(run);
      } else if (isParallelStep(step)) {
        phase.agents = { done: 0, total: step.parallel.length };
        const output = await mapWithConcurrency(
          step.parallel,
          step.concurrency ?? 4,
          async (child) => {
            const result = await runStepWithPermit(
              child,
              template(child.prompt, run.workflow.task, capPreviousOutput(previous), outputs),
            );
            phase.agents!.done += 1;
            persistRun(run);
            return result;
          },
        );
        previous = JSON.stringify(output);
        for (let childIndex = 0; childIndex < step.parallel.length; childIndex++) {
          const child = step.parallel[childIndex]!;
          if (child.as) outputs[child.as] = decodedOutput(output[childIndex]!);
        }
      } else {
        const items = pathValue(outputs[step.expand.from], step.expand.path);
        if (!Array.isArray(items))
          throw new Error(
            `Fan-out source "${step.expand.from}${step.expand.path}" is not an array.`,
          );
        if (items.length > step.expand.maxItems)
          throw new Error(`Fan-out exceeded maxItems (${items.length}/${step.expand.maxItems}).`);
        phase.agents = { done: 0, total: items.length };
        const output = await mapWithConcurrency(items, step.concurrency ?? 4, async (item) => {
          const result = await runStepWithPermit(
            step.parallel,
            template(
              step.parallel.prompt,
              run.workflow.task,
              capPreviousOutput(previous),
              outputs,
              item,
            ),
          );
          phase.agents!.done += 1;
          persistRun(run);
          return result;
        });
        outputs[step.collect.as] = output;
        previous = JSON.stringify(output);
      }
      phase.output = previous;
      phase.status = "completed";
      phase.finishedAt = new Date().toISOString();
      persistRun(run);
    }
    run.status = "completed";
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    const active = run.phases.find((phase) => phase.status === "running");
    if (active) {
      active.status = "failed";
      active.finishedAt = new Date().toISOString();
      persistRun(run);
    }
    run.status = run.controller.signal.aborted ? "stopped" : "failed";
  } finally {
    run.finishedAt = new Date().toISOString();
    persistRun(run);
  }
}

export function registerWorkflowRpc(pi: ExtensionAPI, options: WorkflowRpcOptions = {}): void {
  const bus = rpcBus(pi);
  if (!bus) return;
  const coordinator = options.coordinator ?? executionCoordinator;
  let activeContext: ExtensionContext | undefined;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const runs = new Map<string, WorkflowRun>();
  pi.on("session_start", (_event, ctx) => {
    closed = false;
    activeContext = ctx;
  });
  pi.on("session_shutdown", () => {
    closed = true;
    activeContext = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    coordinator.rejectQueued();
    for (const run of runs.values()) {
      if (run.status === "running") run.controller.abort();
    }
  });
  unsubscribe =
    bus.on(SUBAGENT_RPC_REQUEST_EVENT, (payload) => {
      const request = payload as RpcRequest;
      if (request?.version !== 2 || typeof request.requestId !== "string") return;
      const reply = (success: boolean, data?: unknown, message?: string) =>
        bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
          version: 2,
          requestId: request.requestId,
          success,
          data,
          error: success ? undefined : { message: message ?? "Workflow RPC failed." },
        });
      if (request.method === "ping") {
        reply(true, { available: true });
        return;
      }
      if (closed || !activeContext) {
        reply(false, undefined, "No active Pi extension context is available.");
        return;
      }
      if (request.method === "status") {
        const run = request.params?.id ? runs.get(request.params.id) : undefined;
        if (run) reply(true, toSnapshot(run));
        else {
          const budget = {
            bytes: MAX_WORKFLOW_SNAPSHOT_BYTES,
            lines: MAX_WORKFLOW_SNAPSHOT_LINES,
          };
          reply(
            true,
            Array.from(runs.values(), (candidate) => toSnapshot(candidate, budget)),
          );
        }
        return;
      }
      if (request.method === "stop") {
        const run = request.params?.id ? runs.get(request.params.id) : undefined;
        if (!run || run.status !== "running") {
          reply(false, undefined, "No running workflow matches that id.");
          return;
        }
        run.controller.abort();
        reply(true, { id: run.id, status: "stopping" });
        return;
      }
      if (request.method === "spawn" || request.method === "resume") {
        const resumedRun =
          request.method === "resume" && request.params?.id
            ? runs.get(request.params.id)
            : undefined;
        const workflow =
          request.method === "resume" ? resumedRun?.workflow : request.params?.workflow;
        if (
          !workflow ||
          !Array.isArray(workflow.chain) ||
          maximumPromptRunCount(workflow) === undefined
        ) {
          reply(
            false,
            undefined,
            "Workflow must contain 1–32 prompt-native phases and have a bounded maximum of 100 prompt runs.",
          );
          return;
        }
        const run: WorkflowRun = {
          id: `wf_${randomUUID()}`,
          workflow,
          status: "running",
          startedAt: new Date().toISOString(),
          phases: workflow.chain.map((step, index) => ({
            label: stepLabel(step, index),
            status: "pending",
          })),
          controller: new AbortController(),
          runsDir: request.params?.runsDir ?? resumedRun?.runsDir,
        };
        runs.set(run.id, run);
        persistRun(run);
        void executeRun(run, activeContext, options.runStep, coordinator);
        reply(true, toSnapshot(run));
        return;
      }
      reply(false, undefined, `Unsupported method "${request.method}".`);
    }) ?? undefined;
}
