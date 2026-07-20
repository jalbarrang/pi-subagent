import { describe, expect, it, mock } from 'bun:test';

/**
 * Regression: background workflow phases must run agent discovery with
 * resolved package paths, or every package-provided agent (scout, planner,
 * validator, …) fails with "Unknown agent" even though the subagent tool can
 * see them (observed live: workflow run failed with `Unknown agent: "scout".
 * Available: advisor, bug-hunter, worker.`).
 */

const SENTINEL_PATHS = { prompts: ['sentinel'] } as never;
const captured: Array<Record<string, unknown>> = [];

mock.module('../extensions/subagent/package-paths.js', () => ({
  resolvePackagePaths: async () => SENTINEL_PATHS,
}));

mock.module('../extensions/subagent/agent-runner.js', () => ({
  runAgent: async (_cwd: string, agent: string, task: string, options: Record<string, unknown>) => {
    captured.push(options);
    return { agent, task, exitCode: 0, messages: [{ role: 'assistant', content: 'OK' }], stderr: '', usage: {} };
  },
}));

const { registerWorkflowRpc, SUBAGENT_RPC_REQUEST_EVENT } = await import('../extensions/subagent/workflow-rpc.js');

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
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('workflow agent discovery', () => {
  it('passes resolved package paths to every phase agent run', async () => {
    const bus = new FakeBus();
    const pi = {
      events: bus,
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        if (event === 'session_start') handler({}, { cwd: '/tmp' });
      },
    } as never;
    registerWorkflowRpc(pi);

    bus.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 1,
      requestId: 'req-discovery',
      method: 'spawn',
      params: {
        workflow: {
          name: 'discovery-smoke',
          task: 'smoke',
          chain: [{ agent: 'scout', task: 'Reply OK.' }],
        },
      },
    });

    await waitFor(() => captured.length > 0);
    expect(captured[0]!.resolvedPaths).toBe(SENTINEL_PATHS);
  });
});
