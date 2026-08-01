# @dreki-gg/pi-subagent

Run full prompts that the caller supplies in isolated Pi subprocesses.

## Install

```bash
pi install npm:@dreki-gg/pi-subagent
```

## `subagent` tool

The only LLM-facing surface is the prompt-native `subagent` tool. It does not discover named agents, load persona prompts, or add hidden instructions. Supply the full child prompt and execution controls explicitly.

```json
{
  "label": "auth-recon",
  "prompt": "Inspect the authentication flow. Return verified findings with file references. Do not edit files.",
  "model": "openai-codex/gpt-5.6-luna",
  "thinking": "low",
  "tools": ["read", "grep", "find", "ls"],
  "cwd": "/path/to/repository"
}
```

`label` is optional display metadata only. It never chooses a prompt, model, tools, or other behavior.

### Modes

- Single: `{ prompt, label?, model?, thinking?, tools?, cwd? }`
- Parallel: `{ tasks: [{ prompt, label?, model?, thinking?, tools?, cwd? }], model?, thinking?, tools?, cwd? }`
- Chain: `{ chain: [{ prompt, label?, model?, thinking?, tools?, cwd? }], model?, thinking?, tools?, cwd? }`

Child item controls override call-level defaults. Every prompt must be non-empty. Parallel runs support at most eight items and execute at most four at a time. An explicit empty `tools` array disables all child tools.

A chain replaces each `{previous}` occurrence with the preceding child's final raw text. The engine does not parse or format that output. To bound context growth, it caps it at 64 KiB and appends `[previous output truncated by pi-subagent]` when truncation occurs.

## Execution behavior

Pi children run in JSON print mode with no persisted session and `--no-prompt-templates`. The engine sends the full prompt to stdin exactly as supplied. It does not add a `Task:` prefix or a hidden system prompt. The engine forwards explicit `model`, `thinking`, `tools`, and `cwd` controls. It excludes orchestration tools from children.

Spawned children are leaves. They receive `PI_AGENT_LEAF=1`, do not register this extension, and cannot delegate again. Other trusted Pi context files, skills, and extensions remain Pi-controlled child resources.

Progress, final output, usage, cancellation, and child errors are rendered in the parent tool result.

## Workflow RPC bridge

Extensions can launch reviewed declarative workflows through the process-local `subagents:rpc:v2:*` event contract. The bridge supports lifecycle methods, bound phases, JSON fan-out, output templates, and optional snapshot files. The lifecycle methods are `ping`, `spawn`, `status`, `stop`, and restart-as-`resume`.

Workflow steps are prompt-native:

```json
{
  "version": 2,
  "requestId": "inspect-then-plan-1",
  "method": "spawn",
  "params": {
    "workflow": {
      "name": "inspect-then-plan",
      "task": "Review the requested change",
      "chain": [
        { "label": "inspect", "prompt": "Inspect {task}. Return evidence only.", "tools": ["read", "grep", "find"] },
        { "label": "plan", "prompt": "Create a plan using this prior output:\n\n{previous}" }
      ]
    }
  }
}
```

Workflow prompt steps support `prompt`, optional inert `label`, `as`, `model`, `thinking`, `tools`, and `cwd`. Workflow templates preserve `{task}`, `{previous}`, `{outputs.name}`, and fan-out item placeholders. `{previous}` uses the same neutral 64 KiB cap as tool chains, and workflow parallelism is limited to four child runs.

## Breaking migration

This release removes named agents and personas. Replace legacy `{ agent, task }` calls with a full `{ prompt }` call. Add the previous persona instructions to the prompt. Pass model, thinking, and tools explicitly when necessary. The release removes `list_agents`, `/create-agent`, `/run-agent`, agent scopes, project-agent confirmation, package prompt discovery, bundled prompts, and the Cursor ACP backend. User and project Pi prompt templates remain Pi resources, but this package ignores them.
