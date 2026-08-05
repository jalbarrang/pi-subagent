# `/btw` command research

## Scope and conclusion

This note researches only an equivalent user-initiated `/btw` command for this package. It does not implement it.

The upstream command is a private, TUI-only one-off side-question flow: it starts a background Pi subagent in the current directory with the parent model and reasoning level, opens a live takeover overlay, keeps the result out of the parent model context, persists a compact result card in the session, and notifies the user when it settles. The smallest safe adaptation here is a TUI-only `/btw [question]` command that reuses this repository's existing prompt-native subprocess runner, returns immediately, records a TUI-only `btw-result` entry on completion, and aborts outstanding children during `session_shutdown`. It should not import or recreate upstream's Effect manager, multi-backend system, or takeover UI.

## Sources and version boundary

All external evidence below is primary source code or first-party Pi documentation.

- Upstream source inventory: https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/subagents
- Upstream snapshot inspected: commit `73bf4d826f39b5cab6b7865e706ba4a2669629ca` on `main` (2026-08-04).
- Upstream `/btw` helper: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/by-the-way.ts#L3-L20
- Upstream extension integration: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L202-L263 and https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L623-L722
- Upstream manager limit and settlement guard: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/manager.ts#L45-L52, https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/manager.ts#L303-L311, and https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/manager.ts#L422-L440
- Upstream Pi child backend: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/backends/pi.ts#L42-L50, https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/backends/pi.ts#L282-L306, and https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/backends/pi.ts#L490-L565
- Upstream custom takeover entry points: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/ui/takeover.ts#L56-L104
- Upstream focused helper tests: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/by-the-way.test.ts#L1-L29
- Upstream dependency declaration: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/package.json#L1-L19
- Local engine entry point: `extensions/subagent/index.ts:117-193`
- Local prompt-runner seam: `extensions/subagent/agent-runner.ts:11-65`
- Local subprocess, JSON parsing, stdin transport, and abort path: `extensions/subagent/spawn-utils.ts:33-185`
- Local leaf dispatch policy: `extensions/subagent/dispatch.ts:24-39` and `extensions/subagent/leaf-policy.ts:1-22`
- Local result extraction: `extensions/subagent/agent-result-utils.ts:16-32`
- Installed Pi extension API documentation: `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, especially **Lifecycle Overview**, **ExtensionCommandContext**, **pi.registerCommand**, **pi.appendEntry**, **pi.registerEntryRenderer**, **Custom UI**, **Error Handling**, and **Mode Behavior**.
- Installed Pi TUI documentation: `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`, especially **Component Interface**, **Overlays**, **Overlay Lifecycle**, and **Keyboard Input**.
- Installed Pi environment documentation: `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md`.
- Installed first-party extension examples inspected: `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/commands.ts`, `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/entry-renderer.ts`, `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/status-line.ts`, `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/qna.ts`, and `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/{README.md,index.ts,agents.ts}`.

The repository resolves `@earendil-works/pi-coding-agent` 0.80.6 locally, while the explicitly requested global documentation installation is 0.83.0. The local 0.80.6 declarations do expose `registerCommand`, `appendEntry`, `registerEntryRenderer`, `ctx.mode`, `ctx.hasUI`, and `session_shutdown` in `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`; the implementation must typecheck against the local dependency rather than assuming a newer global API.

## Upstream behavior

### User-facing flow

1. `/btw <question>` trims its argument. With no argument, it prompts with `ctx.ui.input("by the way", "Ask a one-off question…")`; cancelling or entering whitespace is a no-op. It rejects non-TUI modes with a notification when UI is available. Source: [upstream command](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L670-L682).
2. It derives a display title from the first non-empty line, collapses internal whitespace, defaults to `by the way`, and caps the title at 60 Unicode code points including a final ellipsis. Source: [helper](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/by-the-way.ts#L3-L15) and [tests](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/by-the-way.test.ts#L9-L24).
3. It spawns the `pi` backend only, sets `origin: "btw"`, uses `ctx.cwd`, and passes the parent trust decision, selected model, selected thinking level, and model registry. Source: [upstream command](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L684-L704).
4. Once spawned, it opens the selected child in a fullscreen overlay tagged `by the way`. The overlay can display live output, accept steering text, and abort the active run. Source: [command call site](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L713-L721) and [takeover implementation](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/ui/takeover.ts#L56-L104).
5. When it settles, the extension appends a `btw-result` session entry containing the id, title, status, error, original prompt, truncated answer, and Pi child session path. It then emits a success or error notification. It deliberately does not call `sendMessage`, so the answer never enters model context or an automatic follow-up. Source: [settlement delivery](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L202-L241).
6. Its custom entry renderer shows a compact card by default and Markdown output when expanded. Source: [renderer](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L623-L666).

### Isolation from model-facing subagent tools

The upstream domain marks every child as either `model` or `btw`; only `model` children are visible to the LLM-facing wait, cancel, check, and list tools. `btw` children remain in the human dashboard but cannot be inspected or consumed by the parent model. Source: [origin predicate](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/by-the-way.ts#L17-L20) and [tool filtering](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L365-L385).

### Child execution and lifecycle

The upstream `pi` backend creates an in-process `AgentSession`, loads normal resources using a child trust decision, binds extensions in print mode, excludes orchestration/user-interaction tools, and starts the child prompt without adding a `Task:` wrapper. Source: [child creation](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/backends/pi.ts#L282-L306) and [excluded tools](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/backends/pi.ts#L42-L50).

Its session state machine consumes normalized child events, emits exactly one terminal outcome, supports steering a streaming child or a later rerun, and interrupts before disposing the child. Source: [start, steer, and interrupt](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/backends/pi.ts#L502-L565). The manager keeps at most four running children across every origin and backend, reserves the slot before any asynchronous spawn work, and suppresses settlement delivery after disposal. Source: [limit](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/manager.ts#L45-L52), [reservation](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/manager.ts#L422-L440), and [shutdown-safe settlement](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/src/manager.ts#L303-L311). The extension then clears runtime references and disposes the manager on `session_shutdown`. Source: [shutdown handler](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/index.ts#L243-L263).

### Upstream dependencies

`by-the-way.ts` itself only imports the `SubagentOrigin` type, but the full feature relies on the surrounding custom manager, Effect runtime, Pi SDK sessions, TUI components, and three backend implementations. The upstream extension directly declares `effect` and the Claude Agent SDK. Source: [package.json](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/package.json#L1-L19). Therefore copying the 21-line helper alone does not supply `/btw`; copying the full feature would import a different execution architecture and unnecessary dependencies.

## Local architecture and fit

This package is intentionally an isolated, prompt-native Pi subprocess engine. `extensions/subagent/index.ts` has one LLM-facing `subagent` tool and returns before any registration when `PI_AGENT_LEAF=1` (`extensions/subagent/index.ts:117-131`). Its single, parallel, and chain operations call `runPrompt()` (`extensions/subagent/index.ts:157-172`).

`runPrompt()` is the correct reuse seam. It accepts a complete `PromptRun`, optional `AbortSignal`, and a default cwd; delegates through the common leaf-aware dispatcher; then returns normalized messages, usage, model, exit code, stop reason, error message, and stderr (`extensions/subagent/agent-runner.ts:11-65`). A `/btw` command can start this promise without awaiting it, so the command returns immediately and the main agent is not blocked on the side question.

The existing runner already provides most of the required process safety. It starts `pi --mode json -p --no-session --no-prompt-templates`, accepts model and thinking overrides, excludes the project orchestration tools, writes the complete prompt unchanged to stdin, collects JSON events, and converts an abort signal into `SIGTERM` followed by an unrefed `SIGKILL` fallback after five seconds (`extensions/subagent/spawn-utils.ts:58-185`). `dispatchSubagent()` applies the leaf marker and refuses a nested dispatch in an already marked process (`extensions/subagent/dispatch.ts:24-39`). This is stronger and narrower than copying upstream's separate child-tool list.

A local `/btw` run must pass `model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined` and `thinking: pi.getThinkingLevel()` to retain the upstream inheritance behavior. Omitting them would use the child process's default model/level, which is not equivalent. It should leave `tools` undefined, preserving the current engine default: normal child tools except its central orchestration denylist. Its prompt must be the user question exactly as entered after trimming; the local runner is already designed for this and does not prepend `Task:`.

Pi's documented command dispatch occurs before generic input handling, and commands receive `ExtensionCommandContext`. Pi documents that `appendEntry()` is durable but excluded from LLM context, whereas `sendMessage()` participates in context. Therefore an entry renderer is the correct local result surface; a follow-up `sendMessage()` would violate the defining “by the way” isolation behavior. See `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` under **Input Events**, **ExtensionCommandContext**, **pi.appendEntry**, and **Message and Entry Rendering**; the first-party entry example is `/Users/jalbarran/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/entry-renderer.ts`.

## Minimal adaptation plan

### Proposed contract

- Command: `/btw [question]`.
- Availability: TUI only. In RPC, print, or JSON mode, do not launch a child; notify only when the current mode has usable UI.
- Input: trim inline arguments; without arguments, open the documented `ctx.ui.input()` prompt; cancel/blank input does nothing.
- Child: one prompt-native `runPrompt()` subprocess in `ctx.cwd`, with the exact trimmed question, a derived title, current `provider/model`, and current thinking level.
- Completion: append a `btw-result` custom entry and notify the human. Never send the answer as a custom or user message and never expose it through the `subagent` tool.
- Result body: retain the upstream 24 KiB / 600-line display cap and record an explicit truncation marker. Use the current package's `getPromptError()` and `getFinalText()` to distinguish failure output from successful final text.
- Concurrency: hold a per-extension map of outstanding `/btw` runs and reject a fifth run with a user notification. This matches upstream's four-child limit for side questions, though it cannot be a global limit shared with an already-running tool call without a larger runner refactor.
- Shutdown: mark the extension instance closed first, abort every tracked `AbortController`, and remove entries before their completion continuations can append to a torn-down or replacement session. Do not wait indefinitely in `session_shutdown`; the existing process runner already escalates its signal after five seconds.

### File-level changes

1. Add `extensions/subagent/by-the-way.ts` as a small package-local helper. Keep it dependency-free except local prompt-run types if needed. It should provide the Unicode-safe title derivation, a typed `BtwResultData` payload, and pure answer/error truncation formatting. Do not import upstream code wholesale.
2. Update `extensions/subagent/index.ts` to import `ExtensionCommandContext`, `getMarkdownTheme`, `truncateHead`, and the TUI `Markdown`/`Text` types already used by the extension. Register a `btw-result` entry renderer, allocate an incrementing `btw-N` id, maintain the active-run map, register the `/btw` command, and register a shutdown handler that invalidates and aborts active runs. The command should schedule `void runPrompt(...).then(settle).catch(settleUnexpected)` and immediately return.
3. Add `test/by-the-way.test.ts`. Prefer pure helper tests plus an injected/stubbed command-runner seam over a real Pi child process. Capture the registered command from a minimal fake `ExtensionAPI`, as `test/prompt-native-contract.test.ts` already captures the registered tool.
4. Do not change `package.json`, `extensions/subagent/agent-runner.ts`, `extensions/subagent/dispatch.ts`, `extensions/subagent/spawn-utils.ts`, `extensions/subagent/leaf-policy.ts`, workflow RPC, or the LLM-facing `subagent` schema. The existing engine already supplies subprocess transport, cancellation, leaf prevention, and child tool exclusion.

## Test strategy

1. Unit-test title behavior against upstream-compatible cases: first non-empty line, whitespace normalization, blank fallback, 60-code-point ellipsis, and emoji/code-point boundaries. The upstream test is the direct behavior reference: https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/by-the-way.test.ts#L9-L24.
2. Test command registration and leaf behavior: in `PI_AGENT_LEAF=1`, the extension must still register no command or tool surfaces; in a normal environment, `/btw` must be registered with the intended description.
3. Test input/mode branches: non-TUI does not launch; a blank/cancelled input does not launch; inline input is trimmed and becomes the exact child prompt.
4. Test child options: verify cwd is `ctx.cwd`, model is fully qualified from `ctx.model`, thinking is the extension's current level, and no tool override is supplied.
5. Test immediate-return semantics with a deferred fake `runPrompt`: the command resolves before the fake child settles, records one active run, and does not enqueue a parent-model message.
6. Test settlement once: success creates one `btw-result` with capped answer; a nonzero/error/aborted result creates one error result using `getPromptError()`; an unexpected rejected promise is rendered as an error instead of becoming an unhandled rejection.
7. Test teardown race: start a deferred run, emit `session_shutdown`, then settle it. The controller must be aborted and neither `appendEntry` nor `notify` may be called after shutdown. Also verify a fifth active `/btw` is rejected and that a settled run frees its slot.
8. Run `bun test ./test/*.test.ts`, `bun run typecheck`, `bun run lint`, and `bun run format:check`. Manually verify an inline `/btw` while a parent agent is streaming, a blank `/btw` input dialog, success/error cards in a persisted session, `/reload`, and `/new` while a child is running.

## Ambiguities and risks to resolve during implementation

- The local subprocess runner cannot provide upstream's live transcript, steer, restart, or per-child abort UI because it closes stdin after the initial prompt and exposes no process handle beyond the abort signal. A result card plus notification is equivalent in isolation and delivery semantics, not in interactive takeover capability.
- A command-only active map can limit `/btw` jobs to four but cannot count a simultaneous `subagent` tool's internal parallel jobs. Making the four-child cap truly global requires an engine-level process registry, which is outside the requested minimal scope.
- The upstream Pi SDK child loads prompt templates and records a child session; the local engine intentionally starts a disposable subprocess with `--no-prompt-templates`. Preserve the local package contract instead of weakening its isolation to match upstream internals.
- The local process runner's abort listener is not removed after normal settlement (`extensions/subagent/spawn-utils.ts:179-182`). A `/btw` feature must not reuse an `AbortController` and should drop its controller reference when the run settles. Separately improving listener cleanup is possible but not necessary for the feature.
- `appendEntry()` storage is durable and may retain the prompt and answer in the session file. The upstream feature does this too. The command description and future documentation should not imply that a side question is private from someone who can read the session file.
- The requested global docs are newer than the local runtime. Confirm the final renderer and command code with local 0.80.6 typecheck and a TUI smoke test before release.

## Deliberately do not copy

- Do not add upstream's `effect` or Claude SDK dependencies, three backend abstraction, normalized live transcript model, manager, or 64-item history. This package has one purpose-built Pi subprocess engine.
- Do not copy the `subagents` dashboard or `TakeoverView`. It depends on a mutable in-process `AgentSession` and enables steer/restart/abort behavior unavailable through the current one-shot subprocess seam.
- Do not add model-facing `subagent_wait`, `subagent_cancel`, `subagent_check`, or `subagent_list` commands/tools for `/btw` runs. They would erode the upstream distinction that side-question results are human-only.
- Do not deliver a `/btw` answer with `pi.sendMessage()` or `pi.sendUserMessage()`. Those APIs feed the parent model or trigger work; the required behavior is a durable, TUI-only entry.
- Do not add a hidden persona, `Task:` wrapper, or extra system prompt. The local engine's public contract is caller-supplied complete prompt text, and the upstream `/btw` starts its prompt directly.
- Do not alter the local leaf marker or orchestration exclusion list. Reusing `runPrompt()` retains the repository's existing nested-delegation protection.
