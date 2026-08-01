# Pi-subagent engine-only cleanup architecture

> Implementation status: Adopted as a direct breaking cleanup. The implemented design is Pi-only; the Cursor ACP backend, persona resources, named-agent discovery, and compatibility surfaces were removed.

## Executive summary

**Verified:** The repository is not only a subagent execution engine today. It publishes eight persona prompts and one persona-authoring skill, asks Pi's package manager and the filesystem to discover prompts, parses those prompts as a private agent-definition format, selects execution settings from prompt frontmatter, injects the prompt body into a child, exposes discovery/scaffolding tools, and carries the same named-agent contract into `/run-agent` and the workflow RPC bridge. The persona layer is therefore part of package distribution, public schemas, execution, rendering, tests, documentation, and workflow compatibility.

**Recommendation:** Make one prompt-native request the engine boundary: the caller supplies a complete `prompt` plus optional execution controls (`label`, `cwd`, `model`, `thinking`, and `tools`). Keep process isolation, Pi subprocess execution, leaf-child enforcement, single/parallel/chain execution, rendering, usage accounting, cancellation, and the workflow bridge. Remove all prompt discovery, persona metadata, bundled prompts, persona-authoring resources, and persona-shaped handoff parsing. Pass the exact prompt as the child turn rather than splitting a hidden persona into system text and a task into user text.

**Recommendation:** Treat the final contract as a breaking release. If compatibility data justifies a bridge, ship one short deprecation release that accepts both direct prompts and legacy named agents, then remove the legacy path. Do not claim the package is engine-only while it still discovers personas.

## Scope and source notation

This document distinguishes **Verified** facts from **Recommendation** design choices. Repository citations use paths relative to this repository. Pi citations use `PI_ROOT` for `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`, the installed official package at version 0.80.10. Local line ranges refer to the files inspected for this research.

Primary sources inspected completely where relevant were `PI_ROOT/README.md`, `PI_ROOT/docs/extensions.md`, `PI_ROOT/docs/packages.md`, `PI_ROOT/docs/prompt-templates.md`, `PI_ROOT/docs/json.md`, and `PI_ROOT/docs/environment-variables.md`. The official subagent example and the installed runtime source for CLI argument parsing, resource loading, and system-prompt construction were also inspected. Git history was used only to explain how the coupling accumulated.

## Verified current architecture

### 1. Package distribution deliberately ships personas

- `package.json` describes the product as including "parallel scouts, manager workflows, and bundled prompts," and its Pi manifest exports the extension, `skills/`, and `prompts/` (`package.json:2-31`).
- `prompts/` contains eight Markdown definitions: `advisor`, `bug-prover`, `docs-scout`, `planner`, `scout`, `ux-designer`, `validator`, and `worker`. Their frontmatter carries private execution metadata such as `name`, `family`, `tools`, `model`, `thinking`, and `sessionStrategy`.
- `skills/write-an-agent/SKILL.md:1-95` teaches users and models how to create and maintain those persona definitions. This is persona product functionality, not process-spawning machinery.
- A local `npm pack --dry-run --json` reported 50 published entries and explicitly included all eight `prompts/*.md` files, `skills/write-an-agent/SKILL.md`, tests, and research docs. There is no `files` allowlist or `.npmignore`; npm reported that it fell back to `.gitignore`.

Pi treats these package prompt files as standard prompt templates independently of this extension. Official Pi documentation says package `prompts/` directories or `pi.prompts` entries are loaded as prompt templates, whose filenames become slash commands (`PI_ROOT/docs/prompt-templates.md:3-17,31-33`). The same Markdown files therefore have two meanings: Pi exposes them as prompt-template resources, while this extension reinterprets them as named subagent personas.

### 2. Prompt discovery is a dedicated subsystem

`extensions/subagent/agents.ts` defines a private agent model with source, family, execution defaults, system prompt, session strategy, and file path (`extensions/subagent/agents.ts:14-35`). It then:

- Reads all `.md` files from prompt directories, parses frontmatter, requires `name` and `description`, parses tools, and stores the Markdown body as `systemPrompt` (`extensions/subagent/agents.ts:53-104`).
- Walks upward from the requested working directory to find the nearest `.pi/prompts` directory (`extensions/subagent/agents.ts:115-125`).
- Reads every enabled prompt resource returned by Pi's package manager and attempts to parse it as an agent (`extensions/subagent/agents.ts:127-172`).
- Merges package, user, and project definitions by name, with project definitions taking precedence when the chosen scope permits them (`extensions/subagent/agents.ts:175-208`).

This is broader than discovering this package's own prompts: any enabled package prompt with the extension's required frontmatter can become an agent. The extension also directly reads user and project prompt directories instead of consuming only Pi's prompt-template command API.

`extensions/subagent/package-paths.ts` exists solely to instantiate Pi's settings and package managers so persona discovery can see package prompt resources (`extensions/subagent/package-paths.ts:1-24`). The workflow regression test documents that package-path resolution was added because named workflow phases otherwise failed with `Unknown agent` (`test/workflow-agent-discovery.test.ts:3-23,52-78`).

### 3. Named persona selection controls child behavior

The shared runner accepts an `agentName` and `task`, discovers the agent, applies the persona's default model and thinking level, and dispatches the persona body as `systemPrompt` plus persona tools (`extensions/subagent/agent-runner.ts:21-63`). The LLM-facing tool has the same coupling:

- Single, parallel, and chain schemas require an `agent` name and a `task`; scope and project-agent confirmation are public parameters (`extensions/subagent/index.ts:402-461`).
- `runSingleAgent()` looks up the name, derives model/thinking defaults, and passes `agent.systemPrompt` and `agent.tools` to the backend (`extensions/subagent/index.ts:305-366`).
- Tool registration tells the parent model to discover agents, reason in scout/consult/worker families, use named personas, and scaffold definitions with `/create-agent` (`extensions/subagent/index.ts:560-582`).
- Every invocation resolves package paths and discovers personas before mode validation or execution (`extensions/subagent/index.ts:584-603`). Project-persona trust confirmation adds another branch that exists only because the engine reads repo-controlled persona files (`extensions/subagent/index.ts:618-645`).

The result details are also persona-shaped: `agent`, `agentSource`, `agentScope`, and `projectPromptsDir` are returned and rendered, so consumers of tool details can depend on persona provenance (`extensions/subagent/index.ts:220-251,596-603`).

### 4. Historical backend prompt semantics

The Pi backend's spawn options separate `agentName`, `task`, and optional `systemPrompt` (`extensions/subagent/spawn-utils.ts:74-87`). When `systemPrompt` exists, the engine writes it to a mode-0600 temporary file, passes that path through `--append-system-prompt`, and sends `Task: <task>` as the child prompt (`extensions/subagent/spawn-utils.ts:113-145`). Official Pi runtime source confirms that an existing path supplied as a prompt argument is read as UTF-8 (`PI_ROOT/dist/core/resource-loader.js:16-30`) and that append-system-prompt inputs are resolved and appended (`PI_ROOT/dist/core/resource-loader.js:380-398`). Pi's system-prompt builder appends that text to its default system prompt and then adds context files and skills (`PI_ROOT/dist/core/system-prompt.js:7-33,91-105`).

The Cursor ACP backend does not have a system-message channel here. It concatenates the persona body and `Task: <task>` into one ACP text prompt (`extensions/subagent/cursor/acp-runner.ts:162-179`). Consequently, the same named persona has system-level appended instructions in the Pi backend but user-prompt text in the Cursor backend.

The Pi child invocation already provides the core isolation and safety mechanics independently of personas: JSON event mode, print mode, no persisted session, optional model/thinking/tools, and the orchestration denylist (`extensions/subagent/spawn-utils.ts:100-106`). Backend-neutral dispatch adds the leaf marker before choosing Pi or Cursor (`extensions/subagent/cursor/dispatch.ts:28-56`), and the extension registers nothing in an already marked child (`extensions/subagent/index.ts:464-469`). These mechanics can survive the persona removal unchanged in purpose.

### 5. Discovery and persona creation are public product surfaces

`list_agents` is an LLM-facing tool that resolves package paths, discovers prompt definitions, groups them by family, and returns their sources and execution metadata (`extensions/subagent/list-agents.ts:34-115`). `/create-agent` writes a persona template into `.pi/prompts`, tells the main model to refine the family, and reminds it to opt into project-agent discovery (`extensions/subagent/create-agent.ts:1-26,35-95`).

`/run-agent` is also persona-dependent. Its CLI grammar includes scope, project-persona approval, and a required agent name (`extensions/subagent/run-agent-args.ts:1-20,22-92`). The command autocompletes discovered personas (`extensions/subagent/index.ts:1368-1452`), resolves a named definition, inherits its defaults and session strategy, and invokes `runAgent()` (`extensions/subagent/index.ts:1454-1576`). It also automatically copies up to 40 recent user/assistant messages into the task (`extensions/subagent/synthesis.ts:3-27`; `extensions/subagent/index.ts:1254-1267,1491-1499`). That implicit conversation transfer is the opposite of making the caller explicitly own the complete child prompt.

### 6. Workflow RPC and chain handoffs encode persona assumptions

The process-local workflow bridge publicly defines each step as `{agent, task, ...}` and carries `agentScope` on the workflow (`extensions/subagent/workflow-rpc.ts:25-55`). Each phase calls the discovery-based `runAgent()`, resolves package paths, and reports named-agent failures (`extensions/subagent/workflow-rpc.ts:232-251`). Static parallel phases, fan-out, persistence, bounded counts, cancellation, and template replacement are orchestration mechanics; named persona resolution is not required for those capabilities.

Chain mode does more than substitute the previous result. It parses the prior persona's Markdown output into a `subagent-handoff/v1` envelope before passing it onward (`extensions/subagent/index.ts:714-722`). The parser looks for persona-oriented sections such as Goal, Completed, Plan, Architecture, Decisions, Constraints, Risks, Files, Symbols, and Open Questions (`extensions/subagent/handoffs.ts:125-180,205-239`), then renders a `Previous Agent Handoff` with a truncated raw output (`extensions/subagent/handoffs.ts:242-286`). This is an opinionated protocol coupled to bundled output contracts, even though it is not stored under `prompts/`.

### 7. Tests preserve the persona architecture

- `test/agents-family.test.ts:1-42` is entirely a test of persona file discovery and family parsing.
- `test/workflow-agent-discovery.test.ts:1-79` locks in package prompt resolution for named workflow agents.
- `test/workflow-rpc.test.ts:75-89` and `test/workflow-run-files.test.ts:90-125` use `{agent, task}` workflow fixtures.
- `test/leaf-policy.test.ts:28-65`, `test/cursor-acp-missing-binary.test.ts:24-48`, and `test/cursor-acp-runner.e2e.test.ts:20-29` instantiate backend requests with `agentName` and `task`; their safety/backend intent remains useful, but their request fixtures must change.
- Cursor model parsing, permissions, ACP update mapping, and Cursor tests are removed by the user-approved implementation override; workflow snapshot persistence and leaf policy remain.

There is little direct coverage of the primary LLM-facing tool schema, exact prompt transport, chain prompt substitution, rendering detail compatibility, or package contents. The cleanup should add those tests rather than only delete persona tests.

### 8. Documentation presents persona policy as engine policy

The README documents `{agent, task}`, agent discovery, model-routing advice, three agent families, named recommended workflows, `/run-agent`, agent definition frontmatter, eight bundled agents, override precedence, `/create-agent`, and the authoring skill (`README.md:11-43,75-137,139-225`). Its statement that the package has "No Prompt Templates by Design" means no canned workflow templates, but the package does export persona files through Pi's prompt-template resource mechanism (`README.md:227-233`; `package.json:21-30`). An engine-only README needs a comprehensive rewrite rather than a small roster deletion.

### 9. Git history shows incremental, deliberate coupling

- Commit `6fc3289` added `/run-agent`, `sessionStrategy`, and persona-aware session forking.
- Commit `a202243` moved private agents into standard Pi `prompts/`, added `pi.prompts`, and centralized shared spawning. This reduced duplication but made standard Pi prompt resources the persona registry.
- Commit `8aa37c4` added `list_agents` and `/create-agent`.
- Commit `196de12` added scout/consult/worker family metadata and moved orchestration policy into live tool guidance.
- Commit `bbd3882` fixed workflow discovery by resolving package prompt paths for every phase.
- Commit `cb06a8a` correctly moved recursive-delegation prevention to the shared dispatch/spawn boundary. That safety architecture is an example of engine policy that should remain.

The cleanup is therefore not only deleting prompt files. Several later interfaces and fixes assume the registry exists.

## Verified Pi platform constraints and opportunities

- Pi defines prompts as reusable Markdown snippets expanded through slash commands, and it supports global, project, package, settings, and CLI prompt sources (`PI_ROOT/docs/prompt-templates.md:3-17`). Pi does not define this repository's `family`, `tools`, `thinking`, or `sessionStrategy` persona semantics.
- A Pi package may declare only extensions; `skills` and `prompts` are independent optional resource keys (`PI_ROOT/docs/packages.md:116-133`). Removing those keys is supported.
- Pi has first-class `--no-prompt-templates`, `--no-skills`, and `--no-context-files` switches (`PI_ROOT/README.md:586-600`; `PI_ROOT/dist/cli/args.js:127-149,251-259`). Current child arguments use none of those switches (`extensions/subagent/spawn-utils.ts:100-106`).
- Pi distinguishes replacing the system prompt from appending to it, and documents that context files and skills remain appended even with `--system-prompt` (`PI_ROOT/README.md:602-608`).
- Print mode accepts a normal initial prompt and can merge piped stdin (`PI_ROOT/README.md:624-634`). This gives the engine a prompt transport that does not require a persona file or put a potentially large complete prompt in the process argument vector.
- Pi intentionally leaves subagent design to extensions and packages rather than imposing personas (`PI_ROOT/README.md:497`). Its extension API supports custom tools and commands as independent capabilities (`PI_ROOT/docs/extensions.md:56-107`). An engine-only extension is aligned with that separation.

## Coupling inventory

| Concern | Current owner/coupling | Engine-only disposition |
|---|---|---|
| Persona text | `prompts/*.md`; loaded as Pi prompts and parsed privately | Remove from this package |
| Persona authoring | `skills/write-an-agent`, `/create-agent` | Remove |
| Discovery/precedence/trust | `agents.ts`, `package-paths.ts`, `list-agents.ts`, scope parameters | Remove |
| Execution defaults | Prompt frontmatter chooses model, thinking, tools | Caller sends explicit execution controls |
| Child prompt | Persona body as appended system text plus separate task | One exact caller-provided prompt |
| Direct command | `/run-agent` discovers a persona and imports conversation implicitly | Remove from minimal target; a future prompt-native command can be separate |
| Tool result metadata | Agent source/scope/family/name | Optional non-behavioral `label`; no provenance fields |
| Chain protocol | Persona-oriented Markdown parser and envelope | Raw previous final output with a neutral documented size cap |
| Workflow steps | `{agent, task}` plus scope/discovery | `{prompt, label?}` plus explicit execution controls |
| Safety | Leaf marker and orchestration denylist | Keep |
| Backends | Pi subprocess and Cursor ACP | Remove Cursor ACP entirely; retain Pi subprocess execution |
| Rendering/usage/cancellation | Shared engine behavior | Keep |

## Recommended minimal target design

### Design principles

1. **Prompt in, result out.** The engine must not look up, parse, merge, classify, or author prompt definitions.
2. **Labels are inert.** An optional label may improve rendering and diagnostics, but it must never select configuration or instructions.
3. **Execution policy is explicit data.** Model, thinking, tools, working directory, and backend routing belong to each request or documented call-level defaults, not prompt frontmatter.
4. **One Pi prompt contract.** Pi receives the caller-provided prompt text unchanged.
5. **Isolation remains a process/session property.** Preserve ephemeral child sessions, JSON event collection, abort behavior, leaf enforcement, and per-backend isolation.
6. **No opinionated output protocol in the engine.** The caller's prompt requests any output shape it needs. The engine returns the output without parsing domain sections.

### Proposed public tool contract

```ts
interface PromptRun {
  prompt: string;
  label?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
}

interface SubagentParams {
  // Exactly one mode.
  prompt?: string;        // single
  label?: string;
  tasks?: PromptRun[];    // parallel
  chain?: PromptRun[];    // sequential; supports {previous}

  // Optional defaults inherited by each run unless overridden there.
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
}
```

**Recommendation:** Require every `prompt` to be non-empty after trimming. Keep the current exactly-one-mode validation, maximum parallel task count, and concurrency limit. Rename result fields from `agent`/`task` to `label`/`prompt`, and remove `agentSource`, `agentScope`, and `projectPromptsDir`. If stable machine consumers use `details`, version the detail shape or call out the break explicitly.

Example calls:

```json
{"prompt":"Inspect the repository's authentication flow. Return evidence with file and line citations. Do not edit files.","label":"auth-recon","model":"openai-codex/gpt-5.6-luna","thinking":"low","tools":["read","grep","find","ls"]}
```

```json
{"tasks":[{"label":"code","prompt":"Inspect the implementation for the requested change. Return verified facts only. Do not edit files.","tools":["read","grep","find","ls"]},{"label":"docs","prompt":"Read the official local documentation relevant to the requested change. Return API constraints with citations. Do not edit files.","tools":["read","grep","find","ls"]}]}
```

```json
{"chain":[{"label":"plan","prompt":"Create a minimal implementation plan for the user's request. Return exact files, symbols, and validation commands. Do not edit files."},{"label":"implement","prompt":"Implement the plan below. The prompt is complete and you must follow its constraints.\n\n{previous}"}]}
```

### Prompt transport

**Recommendation:** Replace `SpawnPiAgentOptions.agentName`, `task`, and `systemPrompt` with `label?` and required `prompt`. For Pi, start `pi --mode json -p --no-session --no-prompt-templates` with existing model/thinking/tools and leaf exclusions, then write the complete prompt to stdin. Remove the Cursor ACP backend entirely. Do not prefix the Pi prompt with `Task:` and do not expose a system-prompt/persona option in the public engine contract.

Using stdin avoids operating-system argument-length limits and avoids exposing a large prompt in process listings. The prompt remains a normal child turn under Pi's platform system prompt. This is the smallest backend-consistent meaning of "the caller sends the complete prompt." It also removes the temporary persona file and `withFileMutationQueue` usage that only supports `--append-system-prompt`.

**Recommendation:** Add `--no-prompt-templates` to Pi children because a noninteractive delegated turn does not need slash-template discovery and the target explicitly rejects prompt discovery. Retain context files, skills, and trusted non-orchestration extensions by default to preserve Pi's repository rules and useful tool capabilities. "Complete prompt" should mean no hidden persona, not that the engine silently discards project instructions. If fully hermetic children are desired later, add one explicit resource-policy option and test it; do not bundle that larger compatibility change into persona cleanup.

### Chain and workflow behavior

**Recommendation:** Replace `{previous}` with the prior final text exactly, subject only to a neutral byte cap and an explicit truncation marker. Delete `handoffs.ts`; callers that need Decisions/Files/Symbols sections must request them in the preceding prompt. A generic cap preserves context safety without pretending to understand the output.

**Recommendation:** Keep the workflow RPC bridge, but change `WorkflowAgentStep` to a prompt-native step with `prompt`, optional inert `label`, `as`, `model`, `thinking`, `tools`, and optional `cwd`. Remove `WorkflowDefinition.agentScope`, package-path resolution, and named-agent errors. Keep bounded phase/fan-out counts, templating (`{task}`, `{previous}`, `{outputs.*}`, and item expansion), persistence, status, stop, and resume behavior.

### Removed and retained surfaces

**Remove from the final package:**

- `prompts/`
- `skills/write-an-agent/`
- `extensions/subagent/agents.ts`
- `extensions/subagent/list-agents.ts`
- `extensions/subagent/create-agent.ts`
- `extensions/subagent/package-paths.ts`
- `extensions/subagent/run-agent-args.ts`
- `extensions/subagent/synthesis.ts`
- `extensions/subagent/handoffs.ts`
- `list_agents`
- `/create-agent`
- `/run-agent`
- all `agentScope`, `confirmProjectAgents`, family, source, and session-strategy persona behavior

**Retain or refactor:**

- `subagent` single/parallel/chain tool
- backend-neutral dispatcher and leaf environment
- Pi process spawning and JSON event reduction
- model, thinking, tools, cwd overrides
- progress rendering, usage accounting, abort handling, and error propagation
- workflow RPC bridge, bounds, persistence, status, stop, and resume

Removing `/run-agent` is the minimal choice because its special value is persona selection plus implicit conversation import. If direct user-triggered prompt runs remain a product requirement, add a separate `/run-subagent` only after the engine-only migration, with explicit prompt text and explicit `--fork-at`; it must call the same prompt-native runner and must not discover personas or silently copy conversation history.

### Package boundary

**Recommendation:** Change the Pi manifest to extension-only:

```json
{"pi":{"extensions":["./extensions/subagent"]}}
```

Delete package-owned prompt and skill directories. Add an npm `files` allowlist such as `extensions/subagent`, `README.md`, and `LICENSE` so future prompt/test/research files are not accidentally shipped. Verify the tarball rather than relying only on the Pi manifest: removing `pi.prompts` stops Pi registration, but physical persona files would still violate "do not ship."

## Compatibility and migration options

| Option | Compatibility | Time spent in a non-engine-only state | Assessment |
|---|---|---:|---|
| Direct breaking cleanup | Existing `{agent, task}`, `/run-agent`, `list_agents`, workflow `{agent, task}`, and persona overrides stop working | None after release | **Recommended when coordinated migration is possible** |
| One-release dual mode | Add `{prompt}` now; retain named discovery with deprecation warnings for one release | One release | Reasonable if usage is unknown; enforce a removal date |
| Separate compatibility package | Pure engine ships now; an optional package owns old personas and named-agent adaptation | None in the engine | Best long-term compatibility boundary, but creates another package to maintain |
| Keep prompts but stop manifest registration | Pi may not register them, but npm still ships persona content and engine cleanup is incomplete | Indefinite | Reject |
| Treat old `task` as the complete prompt and ignore `agent` | Avoids lookup but silently drops persona instructions, tools, model defaults, and session behavior | None, but behavior is misleading | Reject |

A tool `prepareArguments` shim can map a prompt-native legacy spelling such as `{task: "complete prompt"}` to `{prompt: ...}` when no `agent` is present, but it cannot faithfully translate `{agent, task}` after discovery is removed. Old calls need either the temporary legacy adapter or a clear error explaining that the caller must inline the full instructions and execution settings.

### User and project persona migration

Existing `~/.pi/agent/prompts` and `.pi/prompts` files belong to users/projects and must not be deleted by this package. After the migration, Pi can continue treating them as ordinary prompt templates according to its documented behavior, but `pi-subagent` ignores them. Users who need old named behavior have three explicit choices:

1. Inline the persona body and required execution settings into each caller-generated `subagent` request.
2. Use a caller-owned skill or context instruction that teaches the parent how to construct those complete prompts.
3. Install an optional compatibility/persona package outside the engine boundary, if one is provided.

Bundled model defaults must be documented in migration notes because removing prompts also removes hidden routing. Callers must pass `model`/`thinking`/`tools` or accept Pi/backend defaults.

## Phased cleanup plan

### Phase 0: Decide the compatibility window

1. Search downstream repositories and session/tool-call fixtures for `list_agents`, `/run-agent`, `agentScope`, `confirmProjectAgents`, `subagents:rpc:v1`, and `{agent, task}`.
2. If usage is controlled, choose a direct breaking release. If not, choose exactly one dual-mode deprecation release.
3. Publish the new prompt-native schema and migration examples before removing named calls.

Exit criterion: one documented removal release and an owner for any separate compatibility package.

### Phase 1: Introduce the prompt-native engine seam

1. Create one backend-neutral request type with `prompt`, optional `label`, and explicit execution controls.
2. Change Pi dispatch to receive exactly that prompt and delete Cursor dispatch.
3. Route single, parallel, chain, and workflow execution through one prompt runner.
4. Add direct-prompt tests before changing discovery behavior.
5. If a bridge release was selected, keep named resolution in a clearly isolated legacy adapter that converts a discovered persona to a complete prompt-native request and emits a deprecation notice. New code must not depend on the adapter.

Exit criterion: all non-legacy execution paths run without calling `discoverAgents()` or `resolvePackagePaths()`.

### Phase 2: Remove persona behavior and resources

1. Remove named fields, scope/confirmation fields, persona provenance, discovery/scaffolding tools, `/run-agent`, and persona-oriented tool guidance.
2. Convert workflow RPC steps and fixtures to prompt-native fields.
3. Replace chain handoff parsing with neutral previous-output substitution and delete the parser.
4. Delete bundled prompts and the authoring skill.
5. Change the Pi manifest to extension-only and add an npm `files` allowlist.
6. Rewrite the README around caller-owned prompts, execution controls, isolation, backend differences, workflow RPC, and leaf safety. Add a breaking-change entry to `CHANGELOG.md`.

Exit criterion: repository search finds no production import or public schema for `discoverAgents`, `AgentConfig`, `AgentScope`, `AgentFamily`, `agentSource`, `projectPromptsDir`, `confirmProjectAgents`, `list_agents`, or `create-agent`; package dry-run contains no `prompts/` or `skills/` resources.

### Phase 3: Harden the engine-only boundary

1. Add `--no-prompt-templates` to Pi children and assert it in spawn-argument tests.
2. Add a test proving Pi receives the exact prompt text over stdin.
3. Add tarball/manifest CI assertions that only the extension is exported and no persona resources are published.
4. Verify old named calls fail with one actionable migration error rather than an opaque schema error if no bridge release was used.
5. Re-run typecheck, unit tests, and a real Pi child smoke test.

Exit criterion: tests demonstrate prompt fidelity, no discovery, no shipped personas, preserved leaf policy, and preserved orchestration behavior.

## File, test, documentation, and package impacts

### Production files

| Path | Expected final action |
|---|---|
| `extensions/subagent/index.ts` | Replace persona schemas and lookup with prompt-native requests; remove discovery/create/run-agent registration and persona rendering fields |
| `extensions/subagent/spawn-utils.ts` | Accept `prompt`/`label`, use stdin, add `--no-prompt-templates`, remove system-prompt temp files |
| `extensions/subagent/cursor/` | Delete the Cursor ACP backend entirely (user override) |
| `extensions/subagent/workflow-rpc.ts` | Convert step contract and shared runner; remove scope and package resolution |
| `extensions/subagent/agent-runner-types.ts` | Rename persona-shaped result fields or replace with backend-neutral run types |
| `extensions/subagent/agent-runner.ts` | Replace with prompt runner or fold into one shared execution module |
| `extensions/subagent/agents.ts` | Delete |
| `extensions/subagent/list-agents.ts` | Delete |
| `extensions/subagent/create-agent.ts` | Delete |
| `extensions/subagent/package-paths.ts` | Delete |
| `extensions/subagent/run-agent-args.ts` | Delete with `/run-agent` |
| `extensions/subagent/synthesis.ts` | Delete with implicit conversation import |
| `extensions/subagent/handoffs.ts` | Delete after neutral chain substitution |

### Tests

- Delete `test/agents-family.test.ts`; replace it with prompt-request validation and a no-discovery regression.
- Replace `test/workflow-agent-discovery.test.ts` with a test that every workflow phase forwards the fully rendered prompt and explicit controls to the shared runner without package resolution.
- Update workflow snapshot and run-file fixtures from named agents to labeled prompts; their lifecycle and persistence assertions remain valuable.
- Delete Cursor fixtures; update leaf fixtures from `agentName/task/systemPrompt` to `label/prompt` while preserving safety assertions.
- Add tests for exact prompt fidelity, stdin transport, empty prompt rejection, per-run override precedence, chain `{previous}` substitution and neutral truncation, parallel labels, actionable legacy errors, and tarball contents.

### Documentation

- Rewrite `README.md`; nearly every section after installation currently assumes named personas.
- Add a breaking migration entry to `CHANGELOG.md` with old/new JSON examples, removed tools/commands, workflow RPC changes, model/tool-default changes, and user/project prompt behavior.
- Keep `docs/research/nested-subagent-safety.md` as historical safety rationale, but future implementation docs should not cite its old prompt examples as current architecture.

### Package metadata

- Remove `pi.skills` and `pi.prompts` from `package.json`.
- Change the package description and keywords/copy from specialized agents and bundled prompts to isolated prompt execution.
- Add `files` to constrain the npm artifact.
- Re-evaluate imports/dependencies after deleting discovery, temp-prompt code, and Cursor ACP. Pi peer packages and TypeBox remain justified by the engine; remove the ACP SDK and any now-unused direct dependencies.

## Risks and open decisions

1. **Result-detail consumers:** The process-local workflow bridge and other extensions may inspect persona-shaped details even if no TypeScript API is published. Search consumers before renaming fields.
2. **Workflow event contract:** `subagents:rpc:v1` currently embeds `{agent, task}`. Changing it in place under `v1` is misleading; prefer `subagents:rpc:v2:*` or a version-2 request payload while temporarily accepting v1 in a compatibility adapter.
3. **Prompt hierarchy:** Moving the former persona body from appended system text into the complete user prompt changes instruction priority for Pi-backed runs. This is intentional and breaking.
4. **Routing defaults:** Bundled personas currently hide model, thinking, and tool defaults. Caller-owned routing is cleaner but can change cost, capabilities, and output quality if callers omit controls.
5. **Context policy:** This recommendation disables prompt-template discovery in Pi children but retains context files, skills, and trusted extensions. If stakeholders mean fully hermetic by "isolated," that is a separate product decision with larger compatibility and safety consequences.
6. **Direct command users:** Removing `/run-agent` drops a user-facing convenience and `fork-at` behavior. Add a prompt-native command only if concrete usage warrants its maintenance cost.
7. **Chain output size:** Raw previous output needs a neutral cap. Choose and document the byte limit; do not revive a Markdown-section parser in the engine.
8. **Cursor removal:** The user-approved implementation removes the Cursor ACP backend and its native-tool boundary entirely.

## Validation performed during research

- `npm pack --dry-run --json` completed and verified that the current artifact includes all persona prompts and the persona-authoring skill.
- `bun test ./test/*.test.ts` produced 21 passing tests, 1 skipped Cursor e2e test, and 1 suite-level failure. The failure occurs while importing `extensions/subagent/index.ts`: installed `@earendil-works/pi-coding-agent` 0.80.10 does not export `AuthStorage`.
- `bun run typecheck` failed on the same existing API mismatch: missing `AuthStorage` and missing static `ModelRegistry.create` in `extensions/subagent/index.ts:22,532`.
- `git status --short` was clean before this document was written.

The current validation failure is not caused by this research document, but it should be fixed or naturally removed when `/run-agent` model autocomplete is deleted. Do not use the current green individual tests as evidence that the full suite is healthy.

## Primary source index

### Repository

- `package.json:2-34`
- `README.md:11-43,75-137,139-233`
- `extensions/subagent/agents.ts:14-208`
- `extensions/subagent/agent-runner.ts:21-93`
- `extensions/subagent/index.ts:220-251,305-461,513-645,647-735,1238-1605`
- `extensions/subagent/spawn-utils.ts:74-145`
- `extensions/subagent/cursor/dispatch.ts:28-56`
- `extensions/subagent/cursor/acp-runner.ts:162-179`
- `extensions/subagent/list-agents.ts:34-115`
- `extensions/subagent/create-agent.ts:1-95`
- `extensions/subagent/package-paths.ts:1-24`
- `extensions/subagent/run-agent-args.ts:1-92`
- `extensions/subagent/synthesis.ts:1-28`
- `extensions/subagent/handoffs.ts:1-35,125-180,205-286`
- `extensions/subagent/workflow-rpc.ts:25-55,232-258`
- `test/agents-family.test.ts:1-42`
- `test/workflow-agent-discovery.test.ts:1-79`
- Git commits `6fc3289`, `a202243`, `8aa37c4`, `196de12`, `bbd3882`, and `cb06a8a`

### Official Pi local documentation and source

- `PI_ROOT/README.md:330-408,497,552-634`
- `PI_ROOT/docs/prompt-templates.md:3-17,31-33,55-96`
- `PI_ROOT/docs/packages.md:107-133,190-220`
- `PI_ROOT/docs/extensions.md:56-107,273-314,1090-1241,1375-1445`
- `PI_ROOT/docs/json.md:1-86`
- `PI_ROOT/docs/environment-variables.md:1-88`
- `PI_ROOT/examples/extensions/subagent/README.md:1-147`
- `PI_ROOT/examples/extensions/subagent/agents.ts:1-126`
- `PI_ROOT/examples/extensions/subagent/index.ts` (complete official example)
- `PI_ROOT/dist/cli/args.js:40-70,125-149,235-267`
- `PI_ROOT/dist/core/resource-loader.js:16-30,370-405`
- `PI_ROOT/dist/core/system-prompt.js:7-43,75-105`
