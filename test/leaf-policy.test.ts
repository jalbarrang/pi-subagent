import { describe, expect, it } from 'bun:test';
import subagentExtension from '../extensions/subagent/index.js';
import {
  dispatchSubagent,
  prepareSubagentDispatch,
} from '../extensions/subagent/cursor/dispatch.js';
import {
  AGENT_LEAF_ENV,
  AGENT_LEAF_VALUE,
  CHILD_ORCHESTRATION_TOOL_NAMES,
  createAgentLeafEnvironment,
  isAgentLeafEnvironment,
} from '../extensions/subagent/leaf-policy.js';
import { buildPiAgentArgs } from '../extensions/subagent/spawn-utils.js';

function restoreLeafMarker(previous: string | undefined): void {
  if (previous === undefined) delete process.env[AGENT_LEAF_ENV];
  else process.env[AGENT_LEAF_ENV] = previous;
}

describe('leaf agent policy', () => {
  it('marks child environments without dropping parent values', () => {
    const child = createAgentLeafEnvironment({ PATH: '/fixture', TOKEN: 'secret' });
    expect(child).toEqual({ PATH: '/fixture', TOKEN: 'secret', [AGENT_LEAF_ENV]: AGENT_LEAF_VALUE });
    expect(isAgentLeafEnvironment(child)).toBe(true);
    expect(isAgentLeafEnvironment({ [AGENT_LEAF_ENV]: '0' })).toBe(false);
  });

  it('marks the child options before backend selection', () => {
    const prepared = prepareSubagentDispatch(
      { cwd: '/fixture', agentName: 'worker', task: 'work', model: 'cursor:fixture' },
      { PATH: '/fixture' },
    );
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) throw new Error('dispatch was unexpectedly denied');
    expect(prepared.options.env?.PATH).toBe('/fixture');
    expect(prepared.options.env?.[AGENT_LEAF_ENV]).toBe(AGENT_LEAF_VALUE);
  });

  it('excludes orchestration after an explicit tool allowlist', () => {
    const args = buildPiAgentArgs({
      cwd: '/fixture',
      agentName: 'planner',
      task: 'plan',
      tools: ['read', 'subagent'],
    });
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('read,subagent');
    expect(args).toContain('--exclude-tools');
    expect(args[args.indexOf('--exclude-tools') + 1]).toBe(
      CHILD_ORCHESTRATION_TOOL_NAMES.join(','),
    );
  });

  it('rejects backend dispatch from an already marked process', async () => {
    const previous = process.env[AGENT_LEAF_ENV];
    process.env[AGENT_LEAF_ENV] = AGENT_LEAF_VALUE;
    try {
      const result = await dispatchSubagent({
        cwd: '/fixture',
        agentName: 'worker',
        task: 'delegate again',
        model: 'cursor:missing-on-purpose',
      });
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain('spawned agents are leaves');
      expect(result.errorMessage).not.toContain('Cursor backend unavailable');
    } finally {
      restoreLeafMarker(previous);
    }
  });

  it('registers no extension surfaces in a marked process', () => {
    const previous = process.env[AGENT_LEAF_ENV];
    process.env[AGENT_LEAF_ENV] = AGENT_LEAF_VALUE;
    try {
      const forbiddenPiAccess = new Proxy(
        {},
        {
          get() {
            throw new Error('marked extension accessed the Pi registration API');
          },
        },
      );
      expect(() => subagentExtension(forbiddenPiAccess as never)).not.toThrow();
    } finally {
      restoreLeafMarker(previous);
    }
  });
});
