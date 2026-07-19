/**
 * Run a subagent task on Cursor's Composer family via `cursor-agent acp`,
 * driven by the official @agentclientprotocol/sdk library (the current home of
 * the Agent Client Protocol TypeScript SDK, formerly @zed-industries/agent-client-protocol).
 *
 * Returns the same SpawnPiAgentResult shape as spawnPiAgent so it is a drop-in
 * backend behind dispatchSubagent — rendering, synthesis, and handoffs are
 * unchanged.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { SpawnPiAgentOptions, SpawnPiAgentResult } from '../spawn-utils.js';
import { emptyUsage } from '../spawn-utils.js';
import { parseCursorModel } from './model.js';
import {
  buildCancelledResponse,
  buildPermissionResponse,
  selectPermissionOption,
} from './permissions.js';
import { CursorUpdateReducer } from './update-mapping.js';

/** Resolved lazily so tests and long-lived sessions honour CURSOR_AGENT_BIN changes. */
function cursorBin(): string {
  return process.env.CURSOR_AGENT_BIN || 'cursor-agent';
}

/** True when `command` is an executable path or resolvable on PATH. */
function isInvocable(command: string): boolean {
  const canExecute = (candidate: string): boolean => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (command.includes(path.sep)) return canExecute(command);
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => canExecute(path.join(dir, command)));
}

/**
 * The cursor backend is optional — pi is the only required runtime. Agents
 * routed to `cursor:*` models on a machine without the CLI must fail as a
 * clean AgentResult with a fix, never as an uncaught ENOENT.
 */
function cursorUnavailableMessage(bin: string, displayModel: string): string {
  return `Cursor backend unavailable: "${bin}" is not installed or not on PATH. Model "${displayModel}" needs the cursor-agent CLI — install it or point CURSOR_AGENT_BIN at it. On systems with only pi, give this agent a non-cursor model instead.`;
}

export async function runCursorAcpAgent(options: SpawnPiAgentOptions): Promise<SpawnPiAgentResult> {
  const { model } = parseCursorModel(options.model);
  const displayModel = `cursor:${model}`;

  const result: SpawnPiAgentResult = {
    exitCode: 0,
    messages: [],
    stderr: '',
    wasAborted: false,
    usage: emptyUsage(),
    model: displayModel,
  };

  const reducer = new CursorUpdateReducer(displayModel);
  const seenToolCalls = new Set<string>();

  const bin = cursorBin();
  if (!isInvocable(bin)) {
    const finalized = reducer.finalize('error');
    result.exitCode = 1;
    result.errorMessage = cursorUnavailableMessage(bin, displayModel);
    result.messages = finalized.messages;
    result.usage = finalized.usage;
    result.stopReason = finalized.stopReason;
    return result;
  }

  const proc = spawn(bin, ['--model', model, 'acp'], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Belt-and-braces for spawn failures the preflight cannot see (EACCES,
  // EMFILE, races): surface them through the normal catch path instead of an
  // unhandled 'error' event crashing the host process.
  const spawnFailed = new Promise<never>((_resolve, reject) => {
    proc.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? cursorUnavailableMessage(bin, displayModel)
            : `Cursor backend failed to start ("${bin}"): ${err.message}`,
        ),
      );
    });
  });
  spawnFailed.catch(() => {});

  proc.stderr.on('data', (d: Buffer) => {
    result.stderr += d.toString();
  });

  // Bridge Node child stdio to Web streams for ndJsonStream.
  const stream = ndJsonStream(
    Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
  );

  const client: Client = {
    async requestPermission(params: RequestPermissionRequest) {
      const optionId = selectPermissionOption(params.options);
      return optionId ? buildPermissionResponse(optionId) : buildCancelledResponse();
    },
    async sessionUpdate(note: SessionNotification) {
      const update = note.update;
      reducer.apply(update);

      if (update.sessionUpdate === 'tool_call' && !seenToolCalls.has(update.toolCallId)) {
        seenToolCalls.add(update.toolCallId);
        options.onToolExecutionStart?.({
          toolCallId: update.toolCallId,
          toolName: update.title || update.kind || 'tool',
          args: (update.rawInput as Record<string, unknown>) ?? {},
        });
      }

      // Live snapshot for streaming TUI updates.
      result.messages = [reducer.current()];
      options.onMessage?.(reducer.current());
    },
  };

  const conn = new ClientSideConnection(() => client, stream);

  let sessionId: string | undefined;
  const onAbort = () => {
    result.wasAborted = true;
    if (sessionId) conn.cancel({ sessionId }).catch(() => {});
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 5000);
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const turn = (async () => {
      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      const session = await conn.newSession({ cwd: options.cwd, mcpServers: [] });
      sessionId = session.sessionId;

      const promptText = options.systemPrompt?.trim()
        ? `${options.systemPrompt}\n\nTask: ${options.task}`
        : `Task: ${options.task}`;

      const promptResult = await conn.prompt({
        sessionId,
        prompt: [{ type: 'text', text: promptText }],
      });

      const finalized = reducer.finalize(promptResult.stopReason);
      result.messages = finalized.messages;
      result.usage = finalized.usage;
      result.stopReason = finalized.stopReason;
      result.exitCode = result.wasAborted ? 1 : 0;
    })();
    // A late rejection from the losing branch must not become an unhandled
    // rejection after the race settles.
    turn.catch(() => {});
    await Promise.race([turn, spawnFailed]);
  } catch (err) {
    result.exitCode = 1;
    result.errorMessage = err instanceof Error ? err.message : String(err);
    const finalized = reducer.finalize(result.wasAborted ? 'cancelled' : 'error');
    result.messages = finalized.messages;
    result.usage = finalized.usage;
    result.stopReason = finalized.stopReason;
  } finally {
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    if (!proc.killed) proc.kill();
  }

  return result;
}
