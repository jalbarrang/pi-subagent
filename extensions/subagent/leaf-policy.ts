export const AGENT_LEAF_ENV = "PI_AGENT_LEAF";
export const AGENT_LEAF_VALUE = "1";

export const CHILD_ORCHESTRATION_TOOL_NAMES = [
  "subagent",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
] as const;

export function isAgentLeafEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_LEAF_ENV] === AGENT_LEAF_VALUE;
}

export function createAgentLeafEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, [AGENT_LEAF_ENV]: AGENT_LEAF_VALUE };
}
