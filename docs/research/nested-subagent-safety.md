# Nested subagent safety research

## Question

Can a subagent started from a normal user session call another subagent, and what refactor would prevent unsafe recursive agent spawning while preserving deliberate orchestration in `../pi-workflows`?

## Finding

Yes. A normal `subagent` call starts a fresh Pi process, but that process reloads the normal Pi resources for the same working directory. If `@dreki-gg/pi-subagent` and `@dreki-gg/pi-workflows` are enabled there, the child can receive both orchestration tools. The current spawn path applies an agent tool allowlist only when the agent prompt declares one; it applies no orchestration denylist and carries no depth marker.

This is not a JavaScript call-stack recursion problem. Each level is a separate Pi process or session. The risks are an unbounded process/session tree, multiplicative fan-out and model cost, nested waits, poor cancellation of descendants, and hard-to-review ownership as children become orchestrators.

## Evidence

### Normal-session subagents can recurse

- `extensions/subagent/index.ts` registers the LLM-facing tool under the exact name `subagent` and routes each single, parallel, or chain step through `dispatchSubagent()`.
- `extensions/subagent/spawn-utils.ts` builds `pi --mode json -p --no-session`; it adds `--tools` only when the selected agent declares tools. It does not add `--exclude-tools`, `--no-extensions`, or a child/depth marker.
- The same file calls `spawn()` with `cwd`, `shell`, and `stdio`, but no `env`. Node therefore inherits the parent environment.
- Pi documents that non-interactive child processes still load extensions and package resources unless disabled. `@dreki-gg/pi-subagent` declares `./extensions/subagent` in `package.json`, so a child that resolves this package loads the extension again.
- Pi's CLI and SDK support `--exclude-tools` / `excludeTools`, and the exclusion applies after an allowlist to built-in, extension, and custom tools. Primary sources: Pi `docs/usage.md` under **Tool Options**, Pi `docs/sdk.md` under **Tools**, and `../pi-mono/packages/coding-agent/src/core/sdk.ts` where `excludedToolNames` filters the active registry.

### Current bundled prompts make nesting reachable, not merely theoretical

- `prompts/planner.md` explicitly declares `tools: read, grep, find, ls, subagent` and tells the planner it may consult `advisor` through `subagent`.
- `prompts/worker.md` declares no tool allowlist, so Pi's normal extension/custom tools remain available, and its instructions also permit consulting `advisor` through `subagent`.
- Read-only agents that omit `subagent` from an explicit tool list are incidentally protected, but this is prompt-by-prompt convention rather than a spawn invariant.

### Existing normal-session bounds do not bound recursion

- `extensions/subagent/index.ts` limits one parallel call to eight tasks with four concurrent workers.
- `extensions/subagent/spawn-utils.ts` forwards abort to the immediate child with `SIGTERM`, then `SIGKILL` after five seconds.
- Neither limit applies across descendants. Every child can create another bounded batch, so total work grows geometrically. Killing an immediate child does not establish process-group termination for descendants.

### Workflow children intend to prohibit recursive orchestration, but miss this tool name

- `../pi-workflows/extensions/workflows/agent/create-session.ts` creates each workflow child through the Pi SDK and applies `childToolPolicy()` as `excludeTools` before binding extensions.
- `../pi-workflows/extensions/workflows/agent/policy.ts` excludes `workflow`, `ask_user`, and legacy-looking names `subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_check`, and `subagent_list`.
- It does not exclude the actual `pi-subagent` tool name, `subagent`. A workflow child that loads this package can therefore still call it.
- `../pi-workflows/extensions/workflows/__tests__/child-policy.test.ts` asserts the incomplete list exactly, so current tests preserve the gap rather than detecting cross-package composition.
- The workflow script itself is separately bounded by a 32-call budget and concurrency four, but a child escape through `subagent` bypasses the workflow controller's budget, artifacts, required-gate semantics, timeouts, and progress accounting.

### Cursor-backed subagents are a separate boundary

- `extensions/subagent/cursor/dispatch.ts` routes `cursor:` models to `runCursorAcpAgent()` instead of `spawnPiAgent()`.
- Cursor ACP starts its own agent with `mcpServers: []`; the Pi agent `tools` allowlist does not apply. A Pi `--exclude-tools` refactor therefore hardens Pi-backed children only. The Cursor backend needs an explicit documented support statement or a separate capability investigation; it must not be presented as covered by the Pi child policy.

## Recommended invariant

Only the user-facing parent session or the reviewed workflow script may orchestrate agents. A spawned child is a leaf and must not receive `subagent` or `workflow`, regardless of its prompt frontmatter.

Enforce this at child creation, not in prompt text:

1. Add a named child orchestration denylist at the shared Pi spawn boundary in `pi-subagent`.
2. Always pass it through Pi's `--exclude-tools`, including when an agent also has a `--tools` allowlist.
3. Add a package-owned leaf-process environment marker as defense in depth and for diagnostics. Check it at the backend-neutral dispatcher and at both package extension composition roots so a marked child cannot register either orchestration surface. Do not treat the marker as a hostile-code sandbox because a bash-capable child can alter its environment.
4. Update `pi-workflows` child policy to exclude the exact peer tool name `subagent` and add a composition regression test. Also update every test that locks the current exclusion list.
5. Remove nested-consult instructions and `subagent` frontmatter from leaf agent prompts so prompts match the enforced capability boundary instead of repeatedly attempting a denied tool.
6. State that Cursor ACP is outside the Pi-tool exclusion guarantee until separately proven. Pass the leaf marker into the Cursor process so descendant Pi launches still fail closed, but do not imply that this disables unknown Cursor-native delegation.

## Options considered

### Strict leaf children — recommended

No child may spawn an agent. This gives one clear ownership layer, makes total agent count bounded by the parent call or workflow controller, and is enforceable with existing Pi primitives.

### Configurable maximum depth

A depth environment variable could permit one or more nested levels. This keeps nested consults but does not compose cleanly with workflows, alternate backends, manual Pi launches through bash, or cross-package controllers. Every layer also needs shared budget and cancellation propagation; a depth integer alone prevents infinity but not resource blowups. A boolean leaf marker better matches the selected strict policy. Reject configurable depth unless nested orchestration becomes an explicit product requirement.

### Prompt-only guidance

Removing prompt instructions lowers probability but does not remove the tool. It is not a safety boundary and does not protect user/project-defined agents. Reject.

### Disable all extensions in Pi children

`--no-extensions` would prevent recursion, but it also removes unrelated trusted tools and extension behavior that agents may legitimately need. It is broader than the invariant and would be a compatibility break. Reject.

### Move all normal subagents to the in-process workflow session runner

This would centralize policies and lifecycle but couples the lightweight package to workflow internals and is much larger than necessary. Existing Pi CLI `--exclude-tools` provides the required leaf capability boundary without replacing the process-isolation model. Defer unless process spawning itself becomes a separate target.

## Validation performed

- `bun test ./test/*.test.ts` in `pi-subagent`: 21 passed, 1 skipped, 0 failed.
- Focused scout review of both repositories: 4 `pi-subagent` tests and 24 `pi-workflows` tests passed in its evidence run.
- Repository status already contained user changes in `prompts/advisor.md`, `prompts/planner.md`, and `prompts/ux-designer.md`; this research did not modify them.

## Primary sources

- `extensions/subagent/spawn-utils.ts`
- `extensions/subagent/index.ts`
- `extensions/subagent/agent-runner.ts`
- `extensions/subagent/cursor/dispatch.ts`
- `extensions/subagent/cursor/acp-runner.ts`
- `prompts/planner.md`
- `prompts/worker.md`
- `package.json`
- `../pi-workflows/extensions/workflows/agent/create-session.ts`
- `../pi-workflows/extensions/workflows/agent/policy.ts`
- `../pi-workflows/extensions/workflows/run/agent-call.ts`
- `../pi-workflows/extensions/workflows/__tests__/child-policy.test.ts`
- `../pi-workflows/docs/architecture.md`
- `../pi-workflows/docs/security.md`
- Pi `docs/extensions.md`, `docs/sdk.md`, `docs/usage.md`, `docs/packages.md`, and `docs/environment-variables.md`
- `../pi-mono/packages/coding-agent/src/cli/args.ts`
- `../pi-mono/packages/coding-agent/src/main.ts`
- `../pi-mono/packages/coding-agent/src/core/sdk.ts`
