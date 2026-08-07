/** Claude Code backend: drive the `claude` CLI headlessly and normalize its stream-json output. */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AssistantMessage,
  StopReason,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import {
  emptyUsage,
  runLineDelimitedProcess,
  type SpawnPiAgentOptions,
  type SpawnPiAgentResult,
} from "./spawn-utils.js";

/** Claude reports assistant model as an id string; use it as the display model. */
const CLAUDE_PROVIDER = "anthropic";
const CLAUDE_API = "anthropic-messages";

let cachedClaudeCommand: string | undefined;

/**
 * Resolve the `claude` executable from PATH once. Falls back to the bare name so a
 * shell/PATH lookup at spawn time still finds it; a genuine absence surfaces as a spawn
 * error the runner reports as the run's failure.
 */
export function resolveClaudeCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedClaudeCommand) return cachedClaudeCommand;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        cachedClaudeCommand = candidate;
        return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return names[0]!;
}

/** Reset the resolver cache. Test-only. */
export function resetClaudeCommandCache(): void {
  cachedClaudeCommand = undefined;
}

/**
 * Build headless `claude` args. Tool policy mirrors the pi backend's allowlist semantics:
 * omitted tools grant full autonomy (bypass permission prompts, like a trusted child);
 * an explicit allowlist scopes execution to those tools under the default permission mode;
 * an empty array leaves no tools allowed, so headless permission prompts deny every tool.
 */
export function buildClaudeAgentArgs(options: SpawnPiAgentOptions): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (options.model) args.push("--model", options.model);
  if (options.tools) {
    if (options.tools.length > 0) args.push("--allowedTools", ...options.tools);
  } else {
    args.push("--permission-mode", "bypassPermissions");
  }
  return args;
}

interface ClaudeUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toPiUsage(payload: ClaudeUsagePayload | undefined): Usage {
  const usage = zeroUsage();
  if (!payload) return usage;
  usage.input = payload.input_tokens ?? 0;
  usage.output = payload.output_tokens ?? 0;
  usage.cacheRead = payload.cache_read_input_tokens ?? 0;
  usage.cacheWrite = payload.cache_creation_input_tokens ?? 0;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

function mapStopReason(reason: unknown): StopReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    default:
      return undefined;
  }
}

/** Flatten an Anthropic tool_result content block into a single text string. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as any).text === "string"
          ? (part as any).text
          : typeof part === "string"
            ? part
            : "",
      )
      .join("");
  return "";
}

function toAssistantMessage(message: any): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === "text" && typeof block.text === "string")
      content.push({ type: "text", text: block.text });
    else if (block?.type === "thinking" && typeof block.thinking === "string")
      content.push({
        type: "thinking",
        thinking: block.thinking,
        thinkingSignature: block.signature,
      });
    else if (block?.type === "tool_use" && block.id && block.name)
      content.push({
        type: "toolCall",
        id: String(block.id),
        name: String(block.name),
        arguments: (block.input ?? {}) as Record<string, any>,
      } satisfies ToolCall);
  }
  return {
    role: "assistant",
    content,
    api: CLAUDE_API,
    provider: CLAUDE_PROVIDER,
    model: typeof message?.model === "string" ? message.model : "claude",
    usage: toPiUsage(message?.usage),
    stopReason: mapStopReason(message?.stop_reason) ?? "stop",
    timestamp: Date.now(),
  };
}

function toToolResultMessages(message: any): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== "tool_result" || !block.tool_use_id) continue;
    results.push({
      role: "toolResult",
      toolCallId: String(block.tool_use_id),
      toolName: "",
      content: [{ type: "text", text: toolResultText(block.content) }],
      isError: block.is_error === true,
      timestamp: Date.now(),
    });
  }
  return results;
}

/** Spawn the `claude` CLI headlessly and normalize its stream-json events into pi Messages. */
export function spawnClaudeAgent(options: SpawnPiAgentOptions): Promise<SpawnPiAgentResult> {
  const result: SpawnPiAgentResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    wasAborted: false,
    usage: emptyUsage(),
    model: options.model,
  };

  const command = resolveClaudeCommand(options.env ?? process.env);
  const args = buildClaudeAgentArgs(options);
  // Windows cannot spawn a bare launcher or a .cmd/.bat shim without a shell, even by absolute path.
  const needsShell =
    process.platform === "win32" && (!path.isAbsolute(command) || /\.(cmd|bat)$/i.test(command));
  const toolNames = new Map<string, string>();

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "assistant" && event.message) {
      const msg = toAssistantMessage(event.message);
      result.messages.push(msg);
      result.usage.turns++;
      result.usage.input += msg.usage.input;
      result.usage.output += msg.usage.output;
      result.usage.cacheRead += msg.usage.cacheRead;
      result.usage.cacheWrite += msg.usage.cacheWrite;
      if (msg.usage.totalTokens) result.usage.contextTokens = msg.usage.totalTokens;
      if (msg.model && msg.model !== "claude") result.model = msg.model;
      result.stopReason = msg.stopReason;
      for (const part of msg.content) {
        if (part.type !== "toolCall") continue;
        toolNames.set(part.id, part.name);
        options.onToolExecutionStart?.({
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
        });
      }
      options.onMessage?.(msg);
      return;
    }
    if (event.type === "user" && event.message) {
      for (const toolResult of toToolResultMessages(event.message)) {
        const named = { ...toolResult, toolName: toolNames.get(toolResult.toolCallId) ?? "" };
        result.messages.push(named);
        options.onToolResult?.(named);
      }
      return;
    }
    if (event.type === "result") {
      if (typeof event.total_cost_usd === "number") result.usage.cost = event.total_cost_usd;
      const finalUsage = toPiUsage(event.usage);
      if (finalUsage.totalTokens) result.usage.contextTokens = finalUsage.totalTokens;
      if (event.is_error === true) {
        result.stopReason = "error";
        result.errorMessage ??=
          typeof event.result === "string" ? event.result : `Claude run failed (${event.subtype})`;
      }
    }
  };

  return runLineDelimitedProcess(result, {
    command,
    args,
    cwd: options.cwd,
    prompt: options.prompt,
    env: options.env,
    signal: options.signal,
    needsShell,
    onLine: processLine,
    terminationGraceMs: options.terminationGraceMs,
    terminationForceWaitMs: options.terminationForceWaitMs,
  });
}
