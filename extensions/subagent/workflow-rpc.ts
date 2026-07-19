/**
 * Process-local background workflow bridge for extensions that need to launch
 * a reviewed subagent workflow without giving an LLM a second, mutable launch
 * surface. It intentionally owns orchestration only; children remain ordinary
 * configured pi-subagent agents.
 */

import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getFinalText } from './agent-result-utils.js';
import { runAgent } from './agent-runner.js';
import type { AgentScope } from './agents.js';

export const SUBAGENT_RPC_REQUEST_EVENT = 'subagents:rpc:v1:request';
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = 'subagents:rpc:v1:reply:';

type RpcBus = {
  on(topic: string, listener: (payload: unknown) => void): (() => void) | void;
  emit(topic: string, payload: unknown): void;
};

export interface WorkflowAgentStep {
  agent: string;
  task: string;
  label?: string;
  as?: string;
  model?: string;
  thinking?: string;
}

export interface WorkflowParallelStep {
  parallel: WorkflowAgentStep[];
  label?: string;
  concurrency?: number;
}

export interface WorkflowFanoutStep {
  expand: { from: string; path: string; item: string; maxItems: number };
  parallel: WorkflowAgentStep;
  collect: { as: string };
  label?: string;
  concurrency?: number;
}

export type WorkflowStep = WorkflowAgentStep | WorkflowParallelStep | WorkflowFanoutStep;

export interface WorkflowDefinition {
  name: string;
  description?: string;
  task: string;
  agentScope?: AgentScope;
  chain: WorkflowStep[];
}

interface WorkflowRun {
  id: string;
  workflow: WorkflowDefinition;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  phases: Array<{ label: string; status: 'pending' | 'running' | 'completed' | 'failed'; output?: string }>;
  error?: string;
  controller: AbortController;
}

interface RpcRequest {
  version: 1;
  requestId: string;
  method: 'ping' | 'spawn' | 'status' | 'stop' | 'resume';
  params?: { workflow?: WorkflowDefinition; id?: string };
}

function rpcBus(pi: ExtensionAPI): RpcBus | undefined {
  const events = (pi as unknown as { events?: RpcBus }).events;
  return events && typeof events.on === 'function' && typeof events.emit === 'function' ? events : undefined;
}

function isAgentStep(step: WorkflowStep): step is WorkflowAgentStep {
  return 'agent' in step;
}

function isParallelStep(step: WorkflowStep): step is WorkflowParallelStep {
  return 'parallel' in step && !('expand' in step);
}

function pathValue(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return value;
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((current, part) => {
      if (current === null || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }, value);
}

function template(task: string, workflowTask: string, previous: string, outputs: Record<string, unknown>, item?: unknown): string {
  return task
    .replace(/\{task\}/g, workflowTask)
    .replace(/\{previous\}/g, previous)
    .replace(/\{outputs\.([A-Za-z][\w-]*)\}/g, (_match, key: string) => JSON.stringify(outputs[key] ?? ''))
    .replace(/\{([A-Za-z][\w-]*)\.([A-Za-z][\w-]*)\}/g, (_match, key: string, property: string) => {
      if (!item || key === 'outputs') return _match;
      const value = (item as Record<string, unknown>)[property];
      return value === undefined ? _match : String(value);
    })
    .replace(/\{item\}/g, item === undefined ? '{item}' : JSON.stringify(item));
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = Array.from<R>({ length: values.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await fn(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return result;
}

function stepLabel(step: WorkflowStep, index: number): string {
  if (isAgentStep(step)) return step.label ?? step.agent;
  return step.label ?? `Phase ${index + 1}`;
}

function maximumAgentCount(workflow: WorkflowDefinition): number | undefined {
  if (workflow.chain.length === 0 || workflow.chain.length > 32) return undefined;
  let count = 0;
  for (const step of workflow.chain) {
    if (isAgentStep(step)) {
      count += 1;
    } else if (isParallelStep(step)) {
      if (step.parallel.length === 0) return undefined;
      count += step.parallel.length;
    } else {
      if (!Number.isInteger(step.expand.maxItems) || step.expand.maxItems < 1) return undefined;
      count += step.expand.maxItems;
    }
    if (count > 100) return undefined;
  }
  return count;
}

async function runAgentStep(
  ctx: ExtensionContext,
  definition: WorkflowDefinition,
  step: WorkflowAgentStep,
  task: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runAgent(ctx.cwd, step.agent, task, {
    agentScope: definition.agentScope ?? 'both',
    model: step.model,
    thinking: step.thinking,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.errorMessage ?? result.stderr ?? `Agent "${step.agent}" failed.`);
  }
  return getFinalText(result);
}

async function executeRun(run: WorkflowRun, ctx: ExtensionContext): Promise<void> {
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let previous = '';
  try {
    for (let index = 0; index < run.workflow.chain.length; index++) {
      const step = run.workflow.chain[index]!;
      const phase = run.phases[index]!;
      phase.status = 'running';

      if (isAgentStep(step)) {
        previous = await runAgentStep(
          ctx,
          run.workflow,
          step,
          template(step.task, run.workflow.task, previous, outputs),
          run.controller.signal,
        );
        if (step.as) outputs[step.as] = previous;
      } else if (isParallelStep(step)) {
        const output = await mapWithConcurrency(step.parallel, step.concurrency ?? 4, async (child) =>
          runAgentStep(
            ctx,
            run.workflow,
            child,
            template(child.task, run.workflow.task, previous, outputs),
            run.controller.signal,
          ),
        );
        previous = JSON.stringify(output);
        for (let childIndex = 0; childIndex < step.parallel.length; childIndex++) {
          const child = step.parallel[childIndex]!;
          if (child.as) outputs[child.as] = output[childIndex]!;
        }
      } else {
        const source = outputs[step.expand.from];
        const items = pathValue(source, step.expand.path);
        if (!Array.isArray(items)) {
          throw new Error(`Fan-out source "${step.expand.from}${step.expand.path}" is not an array.`);
        }
        if (items.length > step.expand.maxItems) {
          throw new Error(`Fan-out exceeded maxItems (${items.length}/${step.expand.maxItems}).`);
        }
        const output = await mapWithConcurrency(items, step.concurrency ?? 4, async (item) =>
          runAgentStep(
            ctx,
            run.workflow,
            step.parallel,
            template(step.parallel.task, run.workflow.task, previous, outputs, item),
            run.controller.signal,
          ),
        );
        outputs[step.collect.as] = output;
        previous = JSON.stringify(output);
      }

      phase.output = previous;
      phase.status = 'completed';
    }
    run.status = 'completed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.error = message;
    const active = run.phases.find((phase) => phase.status === 'running');
    if (active) active.status = 'failed';
    run.status = run.controller.signal.aborted ? 'stopped' : 'failed';
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

/**
 * Register the event bridge once in the parent Pi process. It provides
 * background `spawn`, inspectable `status`, stop, and restart-as-resume.
 */
export function registerWorkflowRpc(pi: ExtensionAPI): void {
  const bus = rpcBus(pi);
  if (!bus) return;

  let activeContext: ExtensionContext | undefined;
  const runs = new Map<string, WorkflowRun>();
  pi.on('session_start', (_event, ctx) => {
    activeContext = ctx;
  });

  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (payload) => {
    const request = payload as RpcRequest;
    if (request?.version !== 1 || typeof request.requestId !== 'string') return;
    const reply = (success: boolean, data?: unknown, message?: string) =>
      bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success,
        data,
        error: success ? undefined : { message: message ?? 'Workflow RPC failed.' },
      });

    if (request.method === 'ping') {
      reply(true, { available: true });
      return;
    }
    if (!activeContext) {
      reply(false, undefined, 'No active Pi extension context is available.');
      return;
    }
    if (request.method === 'status') {
      const run = request.params?.id ? runs.get(request.params.id) : undefined;
      reply(true, run ?? Array.from(runs.values()));
      return;
    }
    if (request.method === 'stop') {
      const run = request.params?.id ? runs.get(request.params.id) : undefined;
      if (!run || run.status !== 'running') {
        reply(false, undefined, 'No running workflow matches that id.');
        return;
      }
      run.controller.abort();
      reply(true, { id: run.id, status: 'stopping' });
      return;
    }
    if (request.method === 'spawn' || request.method === 'resume') {
      const workflow =
        request.method === 'resume'
          ? request.params?.id
            ? runs.get(request.params.id)?.workflow
            : undefined
          : request.params?.workflow;
      if (!workflow || !Array.isArray(workflow.chain) || workflow.chain.length === 0) {
        reply(false, undefined, 'A non-empty workflow chain is required.');
        return;
      }
      if (maximumAgentCount(workflow) === undefined) {
        reply(false, undefined, 'Workflow must contain 1–32 phases and have a bounded maximum of 100 agents.');
        return;
      }
      const id = `wf_${randomUUID()}`;
      const run: WorkflowRun = {
        id,
        workflow,
        status: 'running',
        startedAt: new Date().toISOString(),
        phases: workflow.chain.map((step, index) => ({ label: stepLabel(step, index), status: 'pending' })),
        controller: new AbortController(),
      };
      runs.set(id, run);
      void executeRun(run, activeContext);
      reply(true, { id, status: run.status, phases: run.phases });
      return;
    }
    reply(false, undefined, `Unsupported method "${request.method}".`);
  });
}
