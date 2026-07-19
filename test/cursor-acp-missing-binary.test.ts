/**
 * The cursor backend is optional — pi is the only required runtime. On a
 * machine without the cursor-agent CLI, a `cursor:*` dispatch must return a
 * clean failed AgentResult with an actionable message, never crash the host
 * with an uncaught ENOENT.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { runCursorAcpAgent } from '../extensions/subagent/cursor/acp-runner.js';

const ORIGINAL_BIN = process.env.CURSOR_AGENT_BIN;
const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  if (ORIGINAL_BIN === undefined) delete process.env.CURSOR_AGENT_BIN;
  else process.env.CURSOR_AGENT_BIN = ORIGINAL_BIN;
  process.env.PATH = ORIGINAL_PATH;
});

describe('runCursorAcpAgent without cursor-agent installed', () => {
  it('fails cleanly when CURSOR_AGENT_BIN points at a missing binary', async () => {
    process.env.CURSOR_AGENT_BIN = '/definitely/not/installed/cursor-agent';

    const result = await runCursorAcpAgent({
      cwd: tmpdir(),
      agentName: 'test',
      task: 'noop',
      model: 'cursor:composer-2.5',
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('Cursor backend unavailable');
    expect(result.errorMessage).toContain('CURSOR_AGENT_BIN');
    expect(result.stopReason).toBe('error');
  });

  it('fails cleanly when cursor-agent is not on PATH', async () => {
    delete process.env.CURSOR_AGENT_BIN;
    process.env.PATH = tmpdir(); // a real dir that contains no cursor-agent

    const result = await runCursorAcpAgent({
      cwd: tmpdir(),
      agentName: 'test',
      task: 'noop',
      model: 'cursor:composer-2.5',
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('Cursor backend unavailable');
    expect(result.errorMessage).toContain('non-cursor model');
  });
});
