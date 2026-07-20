import { describe, expect, it } from 'bun:test';

type Listener = (payload: unknown) => void;
type RunStep = () => Promise<string>;
type Snapshot = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  phases: Array<{ startedAt?: string; finishedAt?: string; agents?: { done: number; total: number } }>;
};

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
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

describe('workflow RPC snapshots', () => {
  it('tracks fan-out agents and excludes internal run state', async () => {
    const resolvers: Array<() => void> = [];
    let calls = 0;
    const runStep: RunStep = async () => {
      calls += 1;
      if (calls === 1) return JSON.stringify({ items: ['one', 'two'] });
      return new Promise<string>((resolve) => resolvers.push(() => resolve('complete')));
    };
    const bus = createHarness(runStep);
    const spawned = request(bus, 'spawn', 'spawn', {
      workflow: {
        name: 'fan-out',
        task: 'test snapshots',
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

    await waitFor(() => resolvers.length === 2);
    const before = request(bus, 'before', 'status', { id: spawned.id }) as Snapshot;
    expect(JSON.stringify(before)).not.toContain('controller');
    expect(before.phases[1]).toMatchObject({ startedAt: expect.any(String), agents: { done: 0, total: 2 } });

    resolvers.shift()!();
    await waitFor(() => (request(bus, 'during-wait', 'status', { id: spawned.id }) as Snapshot).phases[1]?.agents?.done === 1);
    const during = request(bus, 'during', 'status', { id: spawned.id }) as Snapshot;
    expect(during.phases[1]?.agents).toEqual({ done: 1, total: 2 });

    resolvers.shift()!();
    await waitFor(() => (request(bus, 'complete-wait', 'status', { id: spawned.id }) as Snapshot).status === 'completed');
    const completed = request(bus, 'complete', 'status', { id: spawned.id }) as Snapshot;
    expect(completed.finishedAt).toEqual(expect.any(String));
    expect(completed.phases[1]).toMatchObject({ startedAt: expect.any(String), finishedAt: expect.any(String), agents: { done: 2, total: 2 } });
  });
});
