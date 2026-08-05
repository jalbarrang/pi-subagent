# Upstream subagents port assessment

## Executive recommendation

Port three behaviors at this time. Bound all model-visible child output. Add one process-wide execution coordinator. Harden subprocess cancellation so it stops the full child process tree.

Consider two features only after users show a need. A small active-run view can improve `/btw`. Prompt-native background handles can reduce blocking. Do not port the items that follow:

- the upstream manager and Effect runtime
- alternative backends and in-process Pi sessions
- the full transcript dashboard and steering
- automatic result injection

These recommendations are behavior ports. Do not copy upstream code. The upstream extension package is private and has no license field. The pinned repository tree also has no root license file. This creates a provenance risk for code copying. The local package is MIT licensed, but that license does not apply to upstream code.

## Scope and source pins

This report uses only primary sources.

- **Upstream:** `davis7dotsh/my-pi-setup` at commit [`73bf4d826f39b5cab6b7865e706ba4a2669629ca`](https://github.com/davis7dotsh/my-pi-setup/tree/73bf4d826f39b5cab6b7865e706ba4a2669629ca). All files under [`extensions/subagents`](https://github.com/davis7dotsh/my-pi-setup/tree/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents) were inspected. This includes source, tests, three internal design notes, `package.json`, `package-lock.json`, and `tsconfig.json`.
- **Upstream dependency outside the extension:** The Pi backend imports [`extensions/shared/tool-call-timeout.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/shared/tool-call-timeout.ts#L1-L86). The extension is not a self-contained copy target.
- **Local baseline:** `pi-subagent` commit `6c639fc88f0d8ce89e5a5ad6e55460156868a417`. Local references use repository-relative paths and line ranges at that commit.
- **Pi documentation:** Installed `@earendil-works/pi-coding-agent` version `0.83.0`. Its npm `gitHead` is [`845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/earendil-works/pi/tree/845d6ff1f6643aba440341cce877ce1c43ebbc39). The relevant documents were inspected at that revision. They cover extensions, SDK, TUI, RPC, packages, sessions, keybindings, and themes.
- **Pi examples:** The official subagent example and the related renderer, event, overlay, loader, and status examples were inspected at the same revision.

## Local product invariants

The repository states one narrow purpose: run caller-supplied prompts in isolated Pi subprocesses (`README.md:1-3`). The only LLM-facing interface is one prompt-native tool. It does not discover personas or add hidden instructions (`README.md:11-13`). Labels are inert (`README.md:26`).

A child uses JSON print mode, no persisted session, and no prompt templates. It uses exact stdin transport and explicit controls (`README.md:38-44` and `extensions/subagent/spawn-utils.ts:58-75`). A child is a strict leaf. The extension marks its environment and excludes orchestration tools (`README.md:40-42`, `extensions/subagent/leaf-policy.ts:1-22`, and `extensions/subagent/dispatch.ts:24-39`).

The package has one Pi extension, an npm file allowlist, an MIT license, and no non-Pi runtime dependency (`package.json:2-21,29-33,34-68` and `test/package-contents.test.ts:4-11`). Pi package guidance says bundled Pi packages belong in peer dependencies, while other runtime libraries belong in `dependencies` ([Pi package docs](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/packages.md#L162-L183)).

The workflow bridge already provides reviewed background lifecycle methods. It has `spawn`, `status`, `stop`, and restart-as-`resume` (`README.md:46-70` and `extensions/subagent/workflow-rpc.ts:69-82,395-470`). This reduces the value of a second broad background architecture.

## Upstream capability and architecture inventory

| Area | Upstream capability | Evidence | Local assessment |
|---|---|---|---|
| LLM interface | Five model-facing tools provide fire-and-forget spawn, blocking wait, cancel, check, and list. Spawn selects `pi`, `claude`, or `codex`. | [`index.ts:267-573`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L267-L573), [`prompt.ts:4-78`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/prompt.ts#L4-L78) | The background behavior is compatible for later work. Harness selection and five new tools are not compatible at this time. |
| Runtime composition | An Effect `ManagedRuntime` combines a backend registry with a manager. Tool handlers convert Effect exits to thrown errors. | [`runtime.ts:10-53`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/runtime.ts#L10-L53) | Too large for one subprocess adapter. It adds little value here. |
| Domain model | A backend-neutral event union covers runs, messages, deltas, tools, queues, usage, metadata, and errors. A snapshot stores normalized transcript state. | [`domain.ts:1-203`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/domain.ts#L1-L203) | Useful only with live sessions or multiple adapters. Neither exists locally. |
| Backend seam | `SubagentBackend` has availability, capabilities, scoped spawn, event streaming, send, and interrupt. | [`backend.ts:17-73`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backend.ts#L17-L73) | One local adapter means this seam is hypothetical. Do not add it. |
| Manager | One manager tracks at most four running and 64 total sessions. It bounds stored text and reserves capacity before asynchronous spawn work. | [`manager.ts:45-68`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L45-L68), [`manager.ts:422-526`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L422-L526) | The reservation behavior is valuable. The session manager is not. |
| Settlement | The manager folds terminal outcomes once, tracks wait interest, suppresses delivery after disposal, prunes settled sessions, and isolates listener failures. | [`manager.ts:179-314`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L179-L314) | Several small patterns are useful. A complete manager is unnecessary. |
| Cancellation | Cancel marks results consumed, requests an interrupt, waits five seconds, then force-disposes. Restarts use the same global cap. | [`manager.ts:529-588`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L529-L588), [`manager.ts:625-683`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L625-L683) | Bounded force termination is compatible. Restart semantics do not. |
| Result delivery | Unconsumed results wait until the parent is idle. A later wait can consume them before automatic follow-up delivery. | [`index.ts:175-241`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L175-L241), [`result-delivery.ts:1-20`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/result-delivery.ts#L1-L20) | Automatic model-context injection conflicts with the local result contract. |
| Output bounds | Automatic results use 24 KiB. Wait uses 48 KiB total and 16 KiB per child. Check uses a 2 KiB preview. | [`index.ts:79-122`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L79-L122), [`index.ts:405-442`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L405-L442), [`index.ts:526-537`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L526-L537) | High-value behavior. Local model-visible output is currently unbounded. |
| Pi backend | The Pi adapter creates an in-process, persisted `AgentSession`. It loads trusted resources, binds extensions, streams events, supports steering, and aborts before disposal. | [`pi.ts:98-107`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L98-L107), [`pi.ts:275-306`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L275-L306), [`pi.ts:503-565`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L503-L565) | It removes subprocess and ephemeral-session invariants. Do not port. |
| Pi child policy | The adapter excludes orchestration and user-interaction tools. It also applies a three-minute timeout wrapper to registered child tools. | [`pi.ts:42-50`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L42-L50), [`pi.ts:318-320`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L318-L320), [`tool-call-timeout.ts:1-86`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/shared/tool-call-timeout.ts#L1-L86) | The local leaf policy is stronger. A run deadline needs a separate product decision. |
| Claude backend | The Claude SDK adapter supports streaming input and interrupt. It bypasses permissions, blocks native subagents, and ignores untrusted project settings. | [`claude.ts:321-352`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/claude.ts#L321-L352), [`claude.ts:649-690`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/claude.ts#L649-L690) | It expands scope and permission risk. Do not port. |
| Codex backend | The Codex adapter runs `codex app-server`, handles JSON-RPC, guards a 4 MiB frame buffer, declines server approvals, and maps reasoning effort. | [`codex.ts:27-35`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L27-L35), [`codex.ts:162-199`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L162-L199), [`codex.ts:756-767`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L756-L767), [`codex.ts:835-840`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L835-L840) | Protocol work and model mapping are outside the Pi-only purpose. |
| Codex permissions | The Codex thread uses `approvalPolicy: "never"` and `sandbox: "danger-full-access"`. | [`codex.ts:881-900`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L881-L900) | This is an unacceptable implicit expansion of the local package contract. |
| Process teardown | Codex starts a process group. Teardown signals the group or Windows process tree, then escalates from `SIGTERM` to `SIGKILL`. | [`codex.ts:321-334`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L321-L334), [`codex.ts:977-1050`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L977-L1050) | High-value behavior for local Pi subprocesses. Reimplement it locally. |
| Context usage | Claude uses per-request occupancy. Codex uses the latest request, not cumulative spend. | [`claude.ts:225-260`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/claude.ts#L225-L260), [`codex.ts:200-218`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L200-L218) | Unnecessary. Local Pi JSON messages already report usage. |
| Status formatting | Shared helpers format token counts, context occupancy, and footer activity counts. | [`format.ts:1-74`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/format.ts#L1-L74), [`index.ts:158-173`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L158-L173) | Unnecessary for blocking tool calls. A later active view can use local formatting. |
| Dashboard | `/subagents` opens a full-screen list. It shows status, backend, model, context use, elapsed time, and abort controls. | [`takeover.ts:73-104`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/takeover.ts#L73-L104), [`takeover.ts:118-336`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/takeover.ts#L118-L336) | It depends on long-lived tracked sessions. Do not port the full view. |
| Takeover | A child view shows live transcript state. It supports send, abort, scrolling, paging, throttled renders, and configured keybindings. | [`takeover.ts:345-581`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/takeover.ts#L345-L581) | Steering is incompatible. A small read-only view is compatible for later work. |
| Transcript | The renderer sanitizes ANSI and control characters. It renders user, assistant, reasoning, tool, live, and queued states. | [`transcript.ts:19-182`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/transcript.ts#L19-L182) | It solves a problem the one-shot local adapter does not expose. |
| `/btw` | `/btw` creates a Pi-origin side question, opens takeover, hides it from model tools, appends a durable result, and notifies the user. | [`by-the-way.ts:3-20`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/by-the-way.ts#L3-L20), [`index.ts:202-241`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L202-L241), [`index.ts:358-385`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L358-L385), [`index.ts:669-722`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L669-L722) | Most behavior is already local. Only active-run human controls remain. |
| Package | The extension package is private. It depends on Effect beta and the Claude Agent SDK. | [`package.json:1-19`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/package.json#L1-L19) | These dependencies are not justified locally. |
| Tests | Default tests cover the manager through stubs, output delivery, context use, title/origin behavior, and dashboard selection. Separate live tests cover Claude and Codex. | [`package.json:5-8`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/package.json#L5-L8), [`stub.ts:1-300`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/stub.ts#L1-L300), [`manager.test.ts:1-276`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/manager.test.ts#L1-L276), [`result-delivery.test.ts:1-27`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/result-delivery.test.ts#L1-L27), [`claude.test.ts:1-119`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/claude.test.ts#L1-L119), [`codex.test.ts:1-102`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/codex.test.ts#L1-L102) | Test ideas are useful. The backend fixtures are not. |

## Ranked recommendations

| Rank | Recommendation | Decision | Value | Primary reason |
|---:|---|---|---|---|
| 1 | Bound model-visible output for all modes and updates | `port now` | High | It prevents context overflow and follows Pi tool guidance. |
| 2 | Add one execution coordinator for every local child | `port now` | High | It makes the four-child limit true across tools, workflows, and `/btw`. |
| 3 | Stop the full subprocess tree and fix escalation | `port now` | High | It prevents invisible descendants after abort or shutdown. |
| 4 | Add a small human-only active `/btw` status and cancel view | **Consider later** | Medium | It closes the largest current `/btw` usability gap without adding steering. |
| 5 | Add explicit prompt-native background handles | **Consider later** | Medium | It can reduce parent blocking, but overlaps the workflow bridge and expands the public interface. |
| 6 | Port the full Effect manager and normalized event domain | **Do not port** | Low | It is infrastructure for multiple live adapters, not one subprocess adapter. |
| 7 | Port Claude and Codex backends | **Do not port** | Negative | They violate the Pi-only purpose and add permission and dependency risk. |
| 8 | Replace subprocesses with in-process Pi SDK sessions | **Do not port** | Negative | It removes process isolation and ephemeral-session behavior. |
| 9 | Port the full dashboard, transcript, takeover, steering, and restart UI | **Do not port** | Low at this time | These features require a live session architecture and large TUI maintenance cost. |
| 10 | Automatically inject settled results into model context | **Do not port** | Negative | It makes context changes asynchronous and less predictable. |
| 11 | Port harness-selection prompt text and model mappings | **Do not port** | Negative | The local interface has one Pi adapter and caller-owned routing. |
| 12 | Add Effect and Claude SDK dependencies | **Do not port** | Negative | They add runtime weight without local interface value. |

## Recommended item 1: bound model-visible output

**User value:** A large child answer cannot consume the parent context or break compaction. Pi states that tools must truncate output. Its built-in limit is 50 KiB or 2,000 lines ([Pi extension docs](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L2111-L2161)).

**Current gap:** Single, chain, and parallel model-visible results call `finalOutput()` without a result cap (`extensions/subagent/index.ts:276-293,296-339,377-392`). Streaming updates can also return the full accumulated assistant text (`extensions/subagent/index.ts:258-272`). `/btw` already applies a 24 KiB and 600-line cap at a valid UTF-8 boundary (`extensions/subagent/by-the-way.ts:4-42`).

**Compatibility:** This keeps exact prompt transport, Pi-only execution, leaf children, and current result details. Only model-visible text changes when it exceeds a documented limit.

**Minimal seam:** Add one result-presentation module. Its interface accepts one or more labeled outputs and a total budget. It returns bounded text plus explicit truncation metadata. Keep raw `PromptResult` objects in `details` so renderers and inspections can use them.

**Likely files:** `extensions/subagent/agent-result-utils.ts`, `extensions/subagent/index.ts`, `test/prompt-native-contract.test.ts`, and a focused new result-budget test if needed. Do not route model output through `/btw` types.

**Test strategy:** Test byte and line limits, Unicode boundaries, per-child and aggregate parallel budgets, error text, chain failure text, and partial updates. Assert the total model-visible byte count. Assert raw details remain complete.

**Complexity and risk:** Medium complexity. The primary risk is inconsistent limits between content, updates, and renderers. Define one policy and use it at every model-visible return point.

**Dependencies:** None. Pi already exports truncation helpers, but a small local UTF-8 helper can preserve the current package range.

**Stopping condition:** Stop when every tool content path and `onUpdate` path has a measured bound. Do not add file persistence unless users need machine access to full output.

## Recommended item 2: add one execution coordinator

**User value:** The documented limit becomes a real process-wide limit. This controls cost, CPU, memory, provider load, and subprocess count.

**Current gap:** Parallel tool calls use a local four-worker loop (`extensions/subagent/index.ts:25-26,92-107,342-375`). `/btw` has a separate four-item map (`extensions/subagent/index.ts:27,139-141,193-201`). Workflows have another four-worker limit (`extensions/subagent/workflow-rpc.ts:10-12,193-211,321-370`). These limits do not count each other.

**Upstream behavior:** One manager counts all origins and backends. It reserves a slot before the first asynchronous spawn step, so concurrent calls cannot exceed four ([`manager.ts:422-440`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L422-L440)). Its tests verify that `/btw` consumes the same capacity ([`manager.test.ts:156-183`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/manager.test.ts#L156-L183)).

**Compatibility:** A coordinator strengthens the existing limit. It does not change prompts, adapters, tools, sessions, or leaf policy.

**Minimal seam:** Add a small execution-coordinator module at the `runPrompt()` seam. Its interface reserves and releases permits. It must accept an `AbortSignal` and release a permit in `finally`. Keep surface-specific behavior outside it. Parallel batches can wait for a permit. `/btw` can reject immediately when no permit exists.

**Likely files:** A new `extensions/subagent/execution-coordinator.ts`, `extensions/subagent/agent-runner.ts`, `extensions/subagent/index.ts`, `extensions/subagent/workflow-rpc.ts`, and focused coordinator tests.

**Test strategy:** Start tool, workflow, and `/btw` runs from deferred fakes. Assert that total active runs never exceeds four. Test simultaneous reservations, cancellation while waiting, spawn failure, normal release, and shutdown release.

**Complexity and risk:** Medium complexity. The primary risk is deadlock or an unreleased permit. Keep the interface small and make release idempotent.

**Dependencies:** None. Do not add Effect for a four-permit module.

**Stopping condition:** Stop when all paths use one coordinator and race tests prove the cap. Do not add run history, transcripts, or backend abstractions to this module.

## Recommended item 3: harden subprocess termination

**User value:** Abort and session shutdown stop the Pi child and any shell commands that it started. Users do not get hidden workspace mutations after the parent reports cancellation.

**Current gap:** The local runner starts one direct process without a process group (`extensions/subagent/spawn-utils.ts:88-97`). It sends `SIGTERM`, then checks `proc.killed` before `SIGKILL` (`extensions/subagent/spawn-utils.ts:172-181`). Node documents that `subprocess.killed` means a signal was sent. It does not mean the process stopped ([Node `v26.5.0` child-process docs](https://github.com/nodejs/node/blob/v26.5.0/doc/api/child_process.md#L1780-L1792)). The abort listener also remains attached after normal settlement.

**Upstream behavior:** Codex starts a separate process group on POSIX. Teardown signals the process tree and checks an exit state before escalation ([`codex.ts:321-334`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L321-L334), [`codex.ts:977-1050`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L977-L1050)).

**Compatibility:** This preserves OS process isolation and current abort semantics. It changes only teardown reliability.

**Minimal seam:** Keep `spawnPiAgent()` as the adapter. Add one private process-tree terminator. Track `close` or `exit` explicitly. Remove the abort listener and clear escalation timers in the terminal path.

**Likely files:** `extensions/subagent/spawn-utils.ts`, `test/leaf-policy.test.ts`, and one cross-platform process-fixture test file.

**Test strategy:** Spawn a fixture that starts a descendant. Abort it and verify both processes exit. Test `SIGKILL` escalation, abort-before-spawn completion, normal completion, duplicate abort, spawn error, and listener cleanup. Use `taskkill /T` only in Windows tests.

**Complexity and risk:** Medium-to-high complexity. Process-group behavior differs on POSIX and Windows. A faulty implementation can signal the parent process group.

**Dependencies:** None. Use Node child-process primitives.

**Stopping condition:** Stop when CI proves descendant termination on supported platforms. Do not merge a POSIX-only implementation if Windows remains supported.

## Recommended item 4: consider a small active `/btw` view

**User value:** A user can see that a side question is active and cancel it. This is the primary missing human control after the local `/btw` port.

**Existing overlap:** Local `/btw` has Unicode-safe titles, TUI-only input, inherited execution controls, and background execution. It also has capacity control, durable context-free entries, notifications, shutdown abort, settlement guards, and an output cap (`extensions/subagent/index.ts:139-220`, `extensions/subagent/by-the-way.ts:4-81`, and `test/by-the-way.test.ts:104-249`). Pi confirms that `appendEntry()` persists data and does not add it to LLM context ([Pi extension docs](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L1439-L1455)).

**Missing upstream behavior:** Upstream opens a live takeover view immediately. That view supports transcript streaming, send, abort, scrolling, and paging ([`index.ts:669-722`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L669-L722), [`takeover.ts:345-581`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/takeover.ts#L345-L581)).

**Compatibility:** A read-only active view with cancel is compatible. Steering, restart, child session files, and a normalized transcript are not compatible with the runner.

**Minimal seam:** After the coordinator exists, let `/btw` store a small active record with id, title, start time, status, last bounded text, and controller. A TUI-only command or compact picker can inspect and abort records. Pi overlays support this interface, but every rendered line must respect width ([Pi TUI docs](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/tui.md#L122-L199), [Pi TUI line-width rule](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/tui.md#L310-L325)).

**Likely files:** `extensions/subagent/index.ts`, one small TUI module, `test/by-the-way.test.ts`, and manual TUI checks. Prevent a shared transcript domain.

**Test strategy:** Test active status, cancellation, settlement races, shutdown, width limits, and no parent message delivery. Manually test reload, new session, narrow terminals, and theme changes.

**Complexity and risk:** Medium complexity and high user-interface judgment. Human review is required before implementation.

**Dependencies:** None beyond existing Pi TUI peers.

**Stopping condition:** Do not start until users ask for active visibility or cancellation. Stop at read-only status and cancel. Do not add steering.

## Recommended item 5: consider prompt-native background handles

**User value:** The parent can start independent work, continue its own task, and collect results only when needed. This is the upstream extension's clearest feature that the blocking local tool does not provide.

**Upstream behavior:** Spawn returns an id immediately. Wait, cancel, check, and list operate on tracked sessions. Unconsumed results can arrive later ([`index.ts:267-573`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L267-L573), [`prompt.ts:37-78`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/prompt.ts#L37-L78)).

**Compatibility:** Background execution can remain prompt-native and Pi-only. Do not port automatic result injection. Explicit collection keeps context ownership clear.

**Local overlap:** The workflow bridge already has background spawn, status, stop, bounded fan-out, snapshots, and optional files (`extensions/subagent/workflow-rpc.ts:57-82,227-266,395-470`). A second registry is justified only for direct LLM use.

**Minimal seam:** Add a prompt-run registry above `runPrompt()`. Reuse the coordinator, `AbortController`, output policy, and existing result types. Expose the smallest useful interface. Prefer start, status, collect, and stop. Do not expose backend, origin, transcript, send, or restart concepts.

**Likely files:** A new background-run module, a small registration module or focused additions to `index.ts`, tests for the public tool contract, and README changes. Workflow RPC can use the same registry only if that reduces code and keeps the contracts separate.

**Test strategy:** Test id lifecycle, explicit collection, duplicate collection, cancel, unknown ids, shutdown, bounded retention, output caps, global capacity, and concurrent calls. Test resumed sessions with old tool calls if the public schema changes.

**Complexity and risk:** High complexity. This creates a new public interface, retention policy, and context timing model. It can duplicate the workflow bridge.

**Dependencies:** None. The design must not require Effect or live Pi sessions.

**Stopping condition:** Do not implement without evidence that blocking calls harm real workflows. Stop if the design needs five separate tools, automatic follow-ups, session persistence, or a transcript manager.

## Small robustness ideas worth adopting independently

1. **Validate `cwd` before spawn.** Upstream returns a clear error when the path is not a directory ([`index.ts:299-306`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts#L299-L306)). Add the check near `runPrompt()` or `spawnPiAgent()`. Keep Pi responsible for project trust.
2. **Bound diagnostic storage.** Upstream caps error text, transcript text, final text, and tracked items ([`manager.ts:47-68`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L47-L68)). Local `stderr` and parsed messages can grow without a bound (`extensions/subagent/spawn-utils.ts:98-159`). Cap error tails first. Preserve complete model output in result details only under a documented memory limit.
3. **Ignore late terminal events.** Upstream backends keep explicit settlement or ignored-turn guards ([`pi.ts:310-317`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L310-L317), [`pi.ts:372-403`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L372-L403), [`codex.ts:354-360`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L354-L360), and [`codex.ts:589-610`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L589-L610)). Keep local completion idempotent when cancellation races with process error or close.
4. **Remove listeners and timers on settlement.** The shared timeout helper removes its abort listener. It clears its timer in `finally` ([`tool-call-timeout.ts:51-65`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/shared/tool-call-timeout.ts#L51-L65)). Apply the same pattern to local child abort handling.
5. **Guard listener failures.** The upstream manager prevents one status or render listener from corrupting lifecycle state ([`manager.ts:198-224`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts#L198-L224)). Apply this only if the local coordinator gains subscribers.
6. **Decide on a run deadline separately.** Upstream can time out each in-process child tool call ([`tool-call-timeout.ts:1-86`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/shared/tool-call-timeout.ts#L1-L86)). The local subprocess cannot implement the same behavior. A whole-run deadline changes the public execution contract and needs an explicit decision.
7. **Do not copy the Codex frame cap directly.** Upstream guards a 4 MiB JSON-RPC line ([`codex.ts:27-35`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L27-L35) and [`codex.ts:835-840`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L835-L840)). Pi JSON events can legitimately contain a large final message on one line. Design a spool or parser limit before adding a cap.

## Explicit exclusions

### Alternative backends

Do not port Claude or Codex. The local package description promises Pi subprocess execution (`package.json:2-4`). Upstream adds the Claude SDK and Effect runtime ([`package.json:10-18`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/package.json#L10-L18)). Its Claude adapter bypasses permissions, and its Codex adapter uses danger-full-access ([`claude.ts:329-342`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/claude.ts#L329-L342), [`codex.ts:887-899`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts#L887-L899)).

### In-process Pi sessions

Do not replace the subprocess adapter. Pi documents SDK sessions as the same-process choice and RPC or CLI as the process-isolated choice ([Pi SDK docs](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/sdk.md#L1113-L1131)). Upstream creates persistent child sessions and loads resources through the SDK ([`pi.ts:275-306`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts#L275-L306)). Local children intentionally use `--no-session` and exact stdin transport (`extensions/subagent/spawn-utils.ts:58-75`).

### Full manager and event domain

Do not port the Effect runtime, backend registry, normalized event union, mutable snapshot fold, 64-item history, or stub backend. They form a deep module for three live adapters. Local code has one adapter and one existing runner seam (`extensions/subagent/agent-runner.ts:19-65`). The full architecture will enlarge the interface without local value.

### Full takeover and transcript UI

Do not port the dashboard, live transcript model, steering, restart, context gauge, or persisted child-session links. They depend on upstream session events and `send()` semantics ([`domain.ts:71-203`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/domain.ts#L71-L203), [`takeover.ts:345-581`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/takeover.ts#L345-L581)). The local subprocess closes stdin after one prompt (`extensions/subagent/spawn-utils.ts:70-75,184-185`).

### Automatic result injection

Do not call `pi.sendMessage()` when a background child settles. Pi states that custom messages participate in LLM context, while custom entries do not ([Pi extension docs](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md#L1388-L1455)). Explicit tool returns and explicit background collection preserve a clearer prompt-in, result-out interface.

### Harness prompt text and reasoning maps

Do not port backend-selection guidance, Claude thinking budgets, Codex effort clamping, or model labels. The local caller already owns model and thinking controls (`README.md:13-34`). Backend-specific mappings will reintroduce hidden policy.

### Upstream package structure

Do not copy the private nested package, its beta Effect toolchain, or its lockfile. The local npm package follows Pi package peer guidance. A test checks its file allowlist (`package.json:17-21,29-68` and `test/package-contents.test.ts:4-11`).

## `/btw` overlap and justified follow-up

| Behavior | Upstream | Local | Recommendation |
|---|---|---|---|
| Human-only result | `appendEntry`, not `sendMessage` | Implemented | Keep. No follow-up. |
| Prompt-native exact question | Pi session starts the question directly | Implemented through `runPrompt()` | Keep. No follow-up. |
| Parent model and thinking inheritance | Implemented | Implemented | Keep. No follow-up. |
| Title normalization | 60 code points | Implemented and tested | Keep. No follow-up. |
| Output cap | 24 KiB and 600 lines | Implemented and tested | Keep. Reuse policy concepts, not types. |
| Shutdown suppression | Manager suppresses settlement after disposal | Implemented and tested | Keep. No follow-up. |
| Capacity | Shared with all upstream runs | Separate local `/btw` map | Port through the coordinator at this time. |
| Abort reliability | Session interrupt and scoped disposal | Direct process signal | Port through process-tree teardown at this time. |
| Live status and cancel | Full takeover | Not available after launch | Consider a small human-only view later. |
| Steering, restart, transcript, session file | Implemented | Not available by design | Do not add. |

The new local `/btw` feature captures the high-value upstream behavior (`extensions/subagent/index.ts:139-220` and `extensions/subagent/by-the-way.ts:4-81`). The justified follow-ups are shared capacity and reliable process-tree cancellation. A small active view needs user demand and human interface review. The full upstream takeover is not justified.

## Suggested implementation sequence and stopping conditions

1. **Add model-visible output budgets.** Stop when all final and partial content paths have measured byte and line limits. Release this independently.
2. **Harden subprocess teardown.** Stop when supported-platform tests prove descendant termination and correct escalation. Do not combine this with background handles.
3. **Add the shared execution coordinator.** Stop when race tests cover direct tools, workflows, and `/btw`. Keep the module limited to permit ownership.
4. **Run the full local checks and a real Pi child smoke test.** Stop if the smoke test changes prompt bytes. Stop if it changes leaf policy, model, thinking, or tool selection.
5. **Collect usage feedback.** Stop the porting effort here unless users report missing active `/btw` controls or harmful blocking.
6. **If users request `/btw` controls, prototype a read-only active view.** Require human interface review. Stop before steering or session persistence.
7. **If users report harmful blocking, design prompt-native background handles.** Review the public interface before implementation. Stop if it duplicates workflow RPC or requires automatic result injection.

## Behavior ports, code copying, and provenance

The recommended work reimplements observable behavior against local interfaces. It does not copy the upstream Effect manager, backend adapters, constants, prompt text, TUI classes, tests, or comments.

The upstream nested package declares `"private": true` and has no `license` field ([`package.json:1-19`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/package.json#L1-L19)). The pinned repository tree has no root `LICENSE` file ([pinned root tree](https://github.com/davis7dotsh/my-pi-setup/tree/73bf4d826f39b5cab6b7865e706ba4a2669629ca)). Treat upstream source as all-rights-reserved unless the owner provides a license.

A clean behavior port must use this report, official Pi and Node documentation, and local tests as the specification. Record the upstream commit in the implementation pull request. Do not paste upstream code into this MIT package without explicit permission or a compatible license.

## Test and validation observations

- The local suite passed with `env -u PI_AGENT_LEAF bun test ./test/*.test.ts`: 24 passed and 0 failed. `bun run typecheck`, `bun run lint`, and `bun run format:check` also passed.
- The harness sets `PI_AGENT_LEAF=1` for this research session. The local suite has expected registration-test failures if that variable is present. This is test-environment behavior, not a repository failure (`extensions/subagent/index.ts:132-137` and `test/leaf-policy.test.ts:99-115`).
- The upstream default suite passed after its extension and root dependencies were installed: 20 passed and 0 failed. `npm run check` passed.
- Upstream live Claude and Codex tests were inspected but not run. The package keeps them under a separate `test:live` script ([`package.json:5-8`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/package.json#L5-L8)).
- A clean `npm ci` inside the upstream nested extension failed because its lockfile omitted platform package records required by `@effect/tsgo`. This does not affect the behavior recommendations, but it weakens the nested package as a copy target.

## Primary source index

### Upstream

- [`extensions/subagents/index.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/index.ts)
- [`extensions/subagents/src/domain.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/domain.ts)
- [`extensions/subagents/src/backend.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backend.ts)
- [`extensions/subagents/src/manager.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/manager.ts)
- [`extensions/subagents/src/backends/pi.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/pi.ts)
- [`extensions/subagents/src/backends/claude.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/claude.ts)
- [`extensions/subagents/src/backends/codex.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/codex.ts)
- [`extensions/subagents/src/backends/stub.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/backends/stub.ts)
- [`extensions/subagents/src/runtime.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/runtime.ts)
- [`extensions/subagents/src/format.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/format.ts)
- [`extensions/subagents/src/prompt.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/prompt.ts)
- [`extensions/subagents/src/result-delivery.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/result-delivery.ts)
- [`extensions/subagents/src/by-the-way.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/by-the-way.ts)
- [`extensions/subagents/src/ui/takeover.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/takeover.ts)
- [`extensions/subagents/src/ui/transcript.ts`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/src/ui/transcript.ts)
- [`extensions/subagents/package.json`](https://github.com/davis7dotsh/my-pi-setup/blob/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents/package.json)
- [`extensions/subagents` tests](https://github.com/davis7dotsh/my-pi-setup/tree/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents)

### Local

- `README.md:1-74`
- `package.json:1-69`
- `extensions/subagent/index.ts:1-464`
- `extensions/subagent/agent-runner.ts:1-65`
- `extensions/subagent/spawn-utils.ts:1-187`
- `extensions/subagent/by-the-way.ts:1-81`
- `extensions/subagent/leaf-policy.ts:1-22`
- `extensions/subagent/dispatch.ts:1-39`
- `extensions/subagent/workflow-rpc.ts:1-474`
- `test/by-the-way.test.ts:1-250`
- `test/leaf-policy.test.ts:1-116`
- `test/package-contents.test.ts:1-12`
- `test/prompt-native-contract.test.ts:1-114`
- `test/workflow-prompt-forwarding.test.ts:1-120`
- `test/workflow-rpc.test.ts:1-131`
- `test/workflow-run-files.test.ts:1-148`

### First-party Pi documents

- [Extensions](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/extensions.md)
- [SDK](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/sdk.md)
- [TUI](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/tui.md)
- [RPC](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/rpc.md)
- [Packages](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/packages.md)
- [Session format](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/session-format.md)
- [Keybindings](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/keybindings.md)
- [Themes](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/docs/themes.md)
