import type { BackendName } from "./agent-runner-types.js";
import { createAgentLeafEnvironment, isAgentLeafEnvironment } from "./leaf-policy.js";
import { spawnClaudeAgent } from "./spawn-claude.js";
import {
  emptyUsage,
  spawnPiAgent,
  type SpawnPiAgentOptions,
  type SpawnPiAgentResult,
} from "./spawn-utils.js";

const CLAUDE_MODEL_PREFIX = /^claude-/;

/**
 * Pick the backend for a run whose caller left `backend` unset.
 *
 * A bare `claude-*` id names a Claude Code model, and the only way to reach one is the
 * claude backend; routing it to pi spawns a child that resolves the id through Pi's own
 * provider catalog and bills an Anthropic API key instead. A `provider/modelId` id is
 * Pi's canonical explicit-provider syntax, so the caller already chose where it runs and
 * we leave it alone.
 */
export function resolveBackend(options: SpawnPiAgentOptions): BackendName | undefined {
  if (options.backend) return options.backend;
  const model = options.model;
  if (!model || model.includes("/")) return options.backend;
  return CLAUDE_MODEL_PREFIX.test(model) ? "claude" : options.backend;
}

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
    options: {
      ...options,
      backend: resolveBackend(options),
      env: createAgentLeafEnvironment(options.env ?? env),
    },
  };
}

export function dispatchSubagent(options: SpawnPiAgentOptions): Promise<SpawnPiAgentResult> {
  const prepared = prepareSubagentDispatch(options);
  if (!prepared.allowed) return Promise.resolve(prepared.result);
  return prepared.options.backend === "claude"
    ? spawnClaudeAgent(prepared.options)
    : spawnPiAgent(prepared.options);
}
