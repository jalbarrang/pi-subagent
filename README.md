# @dreki-gg/pi-subagent

Subagent tool and direct agent runs for pi — isolated agents, parallel scouts, manager workflows, and bundled prompts.

## Install

```bash
pi install npm:@dreki-gg/pi-subagent
```

## Subagent Tool

The `subagent` tool supports three modes:

| Mode | Description |
|------|-------------|
| Single | `{ agent, task }` — one agent, one task |
| Parallel | `{ tasks: [...] }` — multiple agents concurrently |
| Chain | `{ chain: [...] }` — sequential with `{previous}` placeholder |

Optional overrides:
- `model` — override the agent's default model for one run, or set a default for all tasks/steps in a call
- `thinking` — override the agent's default reasoning level for one run, or set a default for all tasks/steps in a call

Notes:
- `/run-agent` provides autocomplete for `--model` and `--thinking`
- the `subagent` tool supports the same fields in its schema, but this package does not currently add custom interactive autocomplete for tool-call JSON parameters

### Agent Discovery

The `list_agents` tool lets the model discover available agents (names, descriptions, sources, capabilities) before spawning. It takes an optional `agentScope` (`user` | `project` | `both`, default `user`).

## Cursor Composer (ACP backend)

Set a subagent's model to `cursor:<model>` to run the task on Cursor's agent via the
[Agent Client Protocol](https://agentclientprotocol.com/) instead of spawning a `pi`
process. A bare `cursor:` (or `cursor`) defaults to `composer-2.5`.

```jsonc
// single run on Composer 2.5
{ "agent": "worker", "task": "…", "model": "cursor:composer-2.5" }
```

Works across every mode (single / parallel / chain) and the `/run-agent` command —
routing happens in one shared dispatcher, so the result shape and rendering are
identical to pi-backed subagents.

**Prerequisites**

- `cursor-agent` installed (default `~/.local/bin/cursor-agent`). Override the binary
  with the `CURSOR_AGENT_BIN` env var.
- Authenticated once: `agent login` (or set `CURSOR_API_KEY`).

**Behavior notes**

- Cursor runs **its own tools** in ACP headless mode and auto-executes them; the
  subagent `tools` allowlist and `thinking` level do **not** apply to `cursor:` models.
- Permission prompts (`session/request_permission`) are auto-approved (most permissive
  allow option) so runs never block. Cursor typically does not prompt for normal ops.
- The model is passed as `cursor-agent --model <model> acp`; see `cursor-agent --list-models`
  for available ids (e.g. `cursor:gpt-5.2`).

## Model Routing

Route each task to the model whose strengths match the work instead of one default model for everything:

- **Bulk token burn goes cheap** — log digging, large specs, migrations, clear-spec implementation.
- **User-facing output goes tasteful** — public APIs, SDKs, UI copy go to (or are reviewed by) the highest-taste model.
- **Reviews get the strong model** — cheap models only as an extra perspective, never the sole reviewer.
- **Defaults, not limits** — redo cheap-model output on a stronger model without asking; judge the output, not the price tag.

If your context files (e.g. a global `AGENTS.md`) define a model routing policy — a table scoring your models on intelligence / taste / cost — treat it as authoritative when picking per-task `model` overrides. Result headers and working messages show which model ran each task (` · model`), so quality is auditable per model.

## Opinionated Defaults

This package is intentionally opinionated about orchestration:

- Use **parallel mode for discovery, not competing edits**.
- Prefer **one worker** and surround it with scouts, planners, and reviewers.
- Use **chain mode** when work needs ordered handoffs.
- Treat `reviewer` as a **verifier with fresh context**, not as a second writer.
- Use `advisor` for **targeted second opinions** on tricky or high-risk cases, not as a default extra hop.
- Only split implementation across multiple workers when file ownership is clearly partitioned.

A good default mental model is: **parallel readers, single writer**.

See [`docs/orchestration-principles.md`](./docs/orchestration-principles.md) for the fuller guidance.

## Recommended Usage

In day-to-day use, the main agent should usually call the `subagent` tool from normal conversation.

Safe defaults:
- "spawn a scout for the auth code"
- "run scout and docs-scout in parallel"
- "have planner make a plan, then worker implement it"
- "send this to reviewer"
- "ask advisor whether this migration should be split before sending it to worker"

For direct user-invoked single-agent runs, use:

```text
/run-agent worker implement the auth flow we discussed
/run-agent --model anthropic/claude-opus-4-6 --thinking high reviewer review the latest diff
```

Autocomplete notes:
- `/run-agent --model` suggests available configured models plus models referenced by discovered agents
- `/run-agent --thinking` suggests supported reasoning levels such as `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`

For reusable multi-step workflows, prefer the main agent calling the `subagent` tool directly in `single` / `parallel` / `chain` mode rather than relying on canned slash workflows.

Examples:

```text
spawn scout and docs-scout in parallel for auth session refresh
have worker implement the questionnaire validation fix
send this diff to reviewer, and if a claim needs proof use validator or bug-prover
ask advisor whether this migration should be split before implementation
```

Recommended pattern in practice:
- `parallel`: `scout` + `docs-scout` for repo and docs recon
- `chain`: `scout` → `planner` → `worker` for coherent implementation
- `chain`: `worker` → `reviewer`, then optionally `validator` / `bug-prover`, then `worker` for a prove-before-fix loop
- `single`: `advisor` for a focused second opinion on a hard decision, failing test loop, or high-risk change

`advisor` is a higher-level entry point built on the same `single` / `parallel` / `chain` primitives, meant for capability routing and second opinions. `validator` and `bug-prover` support evidence-driven review: validate a claim first, then build the smallest repro only when needed.

## Direct Agent Runs

Run one agent directly from the current session:

```text
/run-agent [--scope user|project|both] [--model <id>] [--thinking <level>] [--yes-project-agents] <agent> [task]
```

Examples:

```text
/run-agent scout trace how auth state is loaded
/run-agent validator validate whether this suspected regression is real
/run-agent bug-prover create a minimal failing repro for the auth refresh bug
/run-agent advisor sanity-check whether this migration should be split
/run-agent worker implement the refactor we just planned
/run-agent --scope project reviewer review the latest changes
```

If the chosen agent frontmatter sets `sessionStrategy: fork-at`, the command clones the current active path into a new session before running the agent. That keeps long implementation runs isolated in their own branch while preserving the original conversation.

### `run-agent` Flags

| Flag | Meaning |
|------|---------|
| `--scope user|project|both` | Which agent layers to use. Default: `user` |
| `--model <id>` | Override the agent model for this run |
| `--thinking <level>` | Override the default reasoning level for this run |
| `--yes-project-agents` | Disable the confirmation prompt for project-local agents |

## Agent Definitions

Create agent prompt files in `~/.pi/agent/prompts/` or `.pi/prompts/` as markdown with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
sessionStrategy: fork-at
---

System prompt for the agent.
```

### Bundled Agents

The package ships with these agents out of the box:

| Agent | Purpose | Default model | Default reasoning level |
|------|---------|---------------|-------------------------|
| `scout` | Fast codebase recon | `openai/gpt-5.6-luna` | `low` |
| `docs-scout` | Context7-first documentation lookup | `openai/gpt-5.6-luna` | `low` |
| `planner` | Implementation planning | `anthropic/claude-opus-4-6` | `high` |
| `worker` | General-purpose implementation | `cursor:composer-2.5` | — |
| `reviewer` | Code review | `anthropic/claude-opus-4-6` | `high` |
| `validator` | Validate or falsify a specific bug or behavior claim from code, tests, and commands | `anthropic/claude-opus-4-6` | `high` |
| `bug-prover` | Create the smallest failing repro for a suspected bug | `anthropic/claude-opus-4-6` | `high` |
| `advisor` | Focused second-opinion consult for tricky planning, implementation, or review decisions | `anthropic/claude-opus-4-6` | `high` |
| `ux-designer` | Frontend UI design | `anthropic/claude-opus-4-6` | `high` |

Notes:
- `worker`, `reviewer`, and `bug-prover` default to `sessionStrategy: fork-at`.
- "Default reasoning level" maps to the frontmatter field `thinking` and can be overridden per run.

Resolution order is: bundled → user (`~/.pi/agent/prompts/`) → project (`.pi/prompts/`). Project agents override user and bundled agents by name.

To scaffold a new project-local agent, run:

```text
/create-agent <name> [description]
```

This creates `.pi/prompts/<name>.md` with frontmatter and a starter system prompt. The bundled `write-an-agent` skill helps write or tighten agent definitions (sharp role, tool policy, output contract, under 100 lines).

Optional frontmatter:
- `thinking` — default reasoning effort for the spawned pi process
- `sessionStrategy: fork-at` — when used with `/run-agent`, clone the current active branch into a new session before running

> Note: pi supports package-shipped prompts via `pi.prompts` (or conventional `prompts/` directories). This package publishes its bundled agent prompts that way, while user prompts in `~/.pi/agent/prompts/` and project prompts in `.pi/prompts/` still override them by name.

## Bundled Resources

### Skill
- `write-an-agent` — writes or refines concise agent definitions (sharp role, tool policy, output contract, under 100 lines)

### No Prompt Templates by Design
This package intentionally does **not** ship canned workflow prompts.

Prefer:
- normal conversation that leads the main agent to call `subagent`
- direct `/run-agent <agent> ...` for explicit single-agent runs
- examples in this README and `docs/orchestration-principles.md` for common orchestration shapes
