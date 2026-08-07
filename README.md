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

- Single: `{ prompt, label?, backend?, model?, thinking?, tools?, cwd? }`
- Parallel: `{ tasks: [{ prompt, label?, backend?, model?, thinking?, tools?, cwd? }], backend?, model?, thinking?, tools?, cwd? }`
- Chain: `{ chain: [{ prompt, label?, backend?, model?, thinking?, tools?, cwd? }], backend?, model?, thinking?, tools?, cwd? }`

Child item controls override call-level defaults. Every prompt must be non-empty. Parallel runs support at most eight items. Direct tool runs and workflow children share one process-wide four-child execution limit and wait for capacity when necessary. An explicit empty `tools` array disables all child tools.

A chain replaces each `{previous}` occurrence with the preceding child's final raw text. The engine does not parse or format that output. To bound context growth, it caps it at 64 KiB and appends `[previous output truncated by pi-subagent]` when truncation occurs.

## Backends

Each run chooses a backend with `backend`. The default is `pi`; `claude` runs the child on the [Claude Code CLI](https://code.claude.com/docs/en/headless) instead. The engine normalizes both into the same result shape, so parallel, chain, workflow, and rendering behavior is identical across backends.

```json
{
  "backend": "claude",
  "prompt": "Summarize the auth flow. Return file references. Do not edit files.",
  "model": "claude-sonnet-4-5",
  "tools": ["Read", "Grep", "Glob"],
  "cwd": "/path/to/repository"
}
```

`model`, `thinking`, and `tools` are interpreted per backend, so use each backend's own names:

- **`pi`** (default): `model` is `provider/model-id` or a bare id, `thinking` is a pi reasoning level, and `tools` are pi tool names (`read`, `grep`, …).
- **`claude`**: requires the `claude` executable on `PATH`. `model` is a Claude model alias or id (`sonnet`, `claude-sonnet-4-5`, …). The `claude` CLI has no headless reasoning-level flag, so `thinking` is ignored. `tools` are Claude tool names (`Read`, `Bash`, `Grep`, …) and follow the same allowlist semantics as pi: omitting `tools` grants full autonomy (`--permission-mode bypassPermissions`, matching a trusted child), an explicit allowlist scopes the child to those tools under the default permission mode, and an empty `tools` array leaves no tool allowed so headless permission prompts deny every tool. The child runs `claude -p --output-format stream-json --verbose`, owns its own `~/.claude` session transcript, and its assistant text, tool cycles, token usage, and cost are folded into the same tool result.

## Execution behavior

Pi children run in JSON print mode with no persisted session and `--no-prompt-templates`. The engine sends the full prompt to stdin exactly as supplied. It does not add a `Task:` prefix or a hidden system prompt. The engine forwards explicit `model`, `thinking`, `tools`, and `cwd` controls. It excludes orchestration tools from children.

Spawned children are leaves. They receive `PI_AGENT_LEAF=1`, do not register this extension, and cannot delegate again. Other trusted Pi context files, skills, and extensions remain Pi-controlled child resources.

Progress, final output, and child errors returned to the parent model are capped at 48 KiB or 600 lines with `[output truncated by pi-subagent]` when necessary. Parallel summaries also cap each child at 12 KiB or 160 lines. Full child result details remain available to renderers. Usage, cancellation, and child errors are rendered in the parent tool result.

Cancellation first requests graceful tree termination, then forces remaining descendants after five seconds. POSIX children run in a dedicated process group. Windows uses `taskkill /T` for the process tree. `/btw` shares the same four-child limit but rejects immediately when all slots are occupied.

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

Workflow prompt steps support `prompt`, optional inert `label`, `as`, `model`, `thinking`, `tools`, and `cwd`. Workflow templates preserve `{task}`, `{previous}`, `{outputs.name}`, and fan-out item placeholders. `{previous}` uses the same neutral 64 KiB cap as tool chains, and workflow parallelism is limited to four child runs. Workflow children share the same process-wide four-child execution limit as direct tool runs and `/btw`. RPC snapshots cap aggregate phase output and error text at 48 KiB or 600 lines; raw values remain available only inside the workflow for chaining.

## Breaking migration

This release removes named agents and personas. Replace legacy `{ agent, task }` calls with a full `{ prompt }` call. Add the previous persona instructions to the prompt. Pass model, thinking, and tools explicitly when necessary. The release removes `list_agents`, `/create-agent`, `/run-agent`, agent scopes, project-agent confirmation, package prompt discovery, bundled prompts, and the Cursor ACP backend. User and project Pi prompt templates remain Pi resources, but this package ignores them.
