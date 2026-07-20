import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

type Listener = (payload: unknown) => void;
type RunStep = () => Promise<string>;
type Snapshot = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  finishedAt?: string;
  phases: Array<{ agents?: { done: number; total: number } }>;
};
type RunFile = Snapshot & { workflow: { name: string; description?: string }; updatedAt: string };

class FakeBus {
  readonly emitted: Array<{ topic: string; payload: unknown }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  on(topic: string, listener: Listener): () => void {
    const listeners = this.listeners.get(topic) ?? [];
    listeners.push(listener);
    this.listeners.set(topic, listeners);
    return () => this.listeners.set(topic, listeners.filter((candidate) => candidate !== listener));
  }

  emit(topic: string, payload: unknown): void {
    this.emitted.push({ topic, payload });
    for (const listener of this.listeners.get(topic) ?? []) listener(payload);
  }

  reply(requestId: string): { data: unknown } {
    const event = this.emitted.findLast(({ topic }) => topic.endsWith(`:${requestId}`));
    if (!event) throw new Error(`Missing reply for ${requestId}.`);
    return event.payload as { data: unknown };
  }
}

const { registerWorkflowRpc, SUBAGENT_RPC_REQUEST_EVENT } = await import('../extensions/subagent/workflow-rpc.js');

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error('Timed out waiting for workflow progress.');
}

function createHarness(runStep: RunStep): FakeBus {
  const bus = new FakeBus();
  let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
  const pi = {
    events: bus,
    on(event: string, listener: (event: unknown, context: unknown) => void) {
      if (event === 'session_start') sessionStart = listener;
    },
  };

  registerWorkflowRpc(pi as never, { runStep: async () => runStep() });
  sessionStart?.({}, { cwd: process.cwd() });
  return bus;
}

function request(bus: FakeBus, requestId: string, method: string, params?: unknown): unknown {
  bus.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
  return bus.reply(requestId).data;
}

async function readRunFile(path: string): Promise<RunFile | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RunFile;
  } catch {
    return undefined;
  }
}

describe('workflow run files', () => {
  it('persists the fan-out lifecycle only when runsDir is supplied', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'pi-subagent-runs-'));
    const emptyRunsDir = await mkdtemp(join(tmpdir(), 'pi-subagent-empty-runs-'));
    try {
      const resolvers: Array<() => void> = [];
      let calls = 0;
      const bus = createHarness(async () => {
        calls += 1;
        if (calls === 1) return JSON.stringify({ items: ['one', 'two'] });
        return new Promise<string>((resolve) => resolvers.push(() => resolve('complete')));
      });
      const spawned = request(bus, 'spawn', 'spawn', {
        runsDir,
        workflow: {
          name: 'persisted fan-out',
          description: 'writes workflow snapshots',
          task: 'test run files',
          chain: [
            { agent: 'source', task: 'source items', as: 'source' },
            {
              expand: { from: 'source', path: '/items', item: 'item', maxItems: 2 },
              parallel: { agent: 'worker', task: 'process {item}' },
              collect: { as: 'results' },
            },
          ],
        },
      }) as Snapshot;
      const runPath = join(runsDir, `${spawned.id}.json`);

      await waitFor(async () => (await readRunFile(runPath)) !== undefined);
      const initial = (await readRunFile(runPath))!;
      expect(initial.workflow.name).toBe('persisted fan-out');
      expect(initial.updatedAt).toEqual(expect.any(String));
      expect(JSON.stringify(initial)).not.toContain('controller');

      await waitFor(() => resolvers.length === 2);
      resolvers.shift()!();
      await waitFor(async () => (await readRunFile(runPath))?.phases[1]?.agents?.done === 1);
      resolvers.shift()!();
      await waitFor(async () => (await readRunFile(runPath))?.status === 'completed');
      const completed = (await readRunFile(runPath))!;
      expect(completed.phases[1]?.agents).toEqual({ done: 2, total: 2 });
      expect(completed.finishedAt).toEqual(expect.any(String));

      const noRunsDir = createHarness(async () => 'complete');
      request(noRunsDir, 'without-runs-dir', 'spawn', {
        workflow: { name: 'in memory', task: 'do not persist', chain: [{ agent: 'worker', task: 'complete' }] },
      });
      await waitFor(() => (request(noRunsDir, 'without-runs-dir-status', 'status') as Snapshot[])[0]?.status === 'completed');
      expect(await readdir(emptyRunsDir)).toEqual([]);
    } finally {
      await Promise.all([rm(runsDir, { recursive: true, force: true }), rm(emptyRunsDir, { recursive: true, force: true })]);
    }
  });
});
