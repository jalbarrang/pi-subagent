import { createAgentLeafEnvironment, isAgentLeafEnvironment } from "./leaf-policy.js";
import {
  emptyUsage,
  spawnPiAgent,
  type SpawnPiAgentOptions,
  type SpawnPiAgentResult,
} from "./spawn-utils.js";

function nestedDispatchDenied(options: SpawnPiAgentOptions): SpawnPiAgentResult {
  const label = options.label ? ` "${options.label}"` : "";
  const message = `Subagent${label} cannot start: spawned agents are leaves and cannot delegate to another agent.`;
  return {
    exitCode: 1,
    messages: [],
    stderr: message,
    wasAborted: false,
    usage: emptyUsage(),
    model: options.model,
    stopReason: "error",
    errorMessage: message,
  };
}

export function prepareSubagentDispatch(
  options: SpawnPiAgentOptions,
  env: NodeJS.ProcessEnv = process.env,
):
  | { allowed: true; options: SpawnPiAgentOptions }
  | { allowed: false; result: SpawnPiAgentResult } {
  if (isAgentLeafEnvironment(env)) return { allowed: false, result: nestedDispatchDenied(options) };
  return {
    allowed: true,
    options: { ...options, env: createAgentLeafEnvironment(options.env ?? env) },
  };
}

export function dispatchSubagent(options: SpawnPiAgentOptions): Promise<SpawnPiAgentResult> {
  const prepared = prepareSubagentDispatch(options);
  return prepared.allowed ? spawnPiAgent(prepared.options) : Promise.resolve(prepared.result);
}
