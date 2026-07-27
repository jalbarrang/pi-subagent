/**
 * Single routing seam for subagent backends.
 *
 * Models prefixed with `cursor:` run through Cursor's ACP server (Composer
 * family); everything else spawns a pi process as before. Both backends return
 * the identical SpawnPiAgentResult shape, so callers are backend-agnostic.
 */

import { createAgentLeafEnvironment, isAgentLeafEnvironment } from '../leaf-policy.js';
import {
  emptyUsage,
  spawnPiAgent,
  type SpawnPiAgentOptions,
  type SpawnPiAgentResult,
} from '../spawn-utils.js';
import { parseCursorModel } from './model.js';
import { runCursorAcpAgent } from './acp-runner.js';

function nestedDispatchDenied(options: SpawnPiAgentOptions): SpawnPiAgentResult {
  const message = `Agent "${options.agentName}" cannot start: spawned agents are leaves and cannot delegate to another agent.`;
  return {
    exitCode: 1,
    messages: [],
    stderr: message,
    wasAborted: false,
    usage: emptyUsage(),
    model: options.model,
    stopReason: 'error',
    errorMessage: message,
  };
}

export function prepareSubagentDispatch(
  options: SpawnPiAgentOptions,
  env: NodeJS.ProcessEnv = process.env,
):
  | { allowed: true; options: SpawnPiAgentOptions }
  | { allowed: false; result: SpawnPiAgentResult } {
  if (isAgentLeafEnvironment(env)) {
    return { allowed: false, result: nestedDispatchDenied(options) };
  }
  return {
    allowed: true,
    options: { ...options, env: createAgentLeafEnvironment(options.env ?? env) },
  };
}

export function dispatchSubagent(options: SpawnPiAgentOptions): Promise<SpawnPiAgentResult> {
  const prepared = prepareSubagentDispatch(options);
  if (!prepared.allowed) return Promise.resolve(prepared.result);

  if (parseCursorModel(options.model).isCursor) {
    return runCursorAcpAgent(prepared.options);
  }
  return spawnPiAgent(prepared.options);
}
