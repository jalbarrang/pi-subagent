/** Shared utilities for spawning isolated prompt-native Pi subprocesses. */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { UsageStats } from "./agent-runner-types.js";
import { CHILD_ORCHESTRATION_TOOL_NAMES } from "./leaf-policy.js";

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualPath = currentScript?.startsWith("/$bunfs/");

  if (currentScript && !isBunVirtualPath && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface ToolExecutionStartEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface SpawnPiAgentOptions {
  cwd: string;
  prompt: string;
  label?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onMessage?: (msg: Message) => void;
  onToolResult?: (msg: Message) => void;
  onToolExecutionStart?: (event: ToolExecutionStartEvent) => void;
}

export interface SpawnPiAgentResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  wasAborted: boolean;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function buildPiAgentArgs(options: SpawnPiAgentOptions): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates"];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools) {
    if (options.tools.length > 0) args.push("--tools", options.tools.join(","));
    else args.push("--no-tools");
  }
  args.push("--exclude-tools", CHILD_ORCHESTRATION_TOOL_NAMES.join(","));
  return args;
}

/** End stdin after writing the caller's complete prompt without transformation. */
export function sendPromptToStdin(
  stdin: { end(chunk: string, encoding?: BufferEncoding): unknown },
  prompt: string,
): void {
  stdin.end(prompt, "utf8");
}

/** Spawn Pi and send the caller-provided complete prompt, unchanged, over stdin. */
export async function spawnPiAgent(options: SpawnPiAgentOptions): Promise<SpawnPiAgentResult> {
  const result: SpawnPiAgentResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    wasAborted: false,
    usage: emptyUsage(),
  };

  const args = buildPiAgentArgs(options);
  return new Promise<SpawnPiAgentResult>((resolve) => {
    const invocation = getPiInvocation(args);
    const needsShell = process.platform === "win32" && invocation.command === "pi";
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: needsShell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    let stdinErrored = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) processLine(buffer);
      result.exitCode = exitCode;
      resolve(result);
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        result.messages.push(msg);
        if (msg.role === "assistant") {
          result.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            result.usage.input += usage.input || 0;
            result.usage.output += usage.output || 0;
            result.usage.cacheRead += usage.cacheRead || 0;
            result.usage.cacheWrite += usage.cacheWrite || 0;
            result.usage.cost += usage.cost?.total || 0;
            result.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!result.model && msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
        options.onMessage?.(msg);
      }
      if (event.type === "tool_result_end" && event.message) {
        result.messages.push(event.message as Message);
        options.onToolResult?.(event.message as Message);
      }
      if (event.type === "tool_execution_start" && event.toolName) {
        options.onToolExecutionStart?.({
          toolCallId: event.toolCallId ?? "",
          toolName: event.toolName,
          args: event.args ?? {},
        });
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });
    proc.stdin.once("error", (error) => {
      stdinErrored = true;
      result.errorMessage ??= error.message;
      result.stderr += error.message;
    });
    proc.once("close", (code) => finish(stdinErrored ? 1 : (code ?? 1)));
    proc.once("error", (error) => {
      result.errorMessage = error.message;
      result.stderr += error.message;
      finish(1);
    });

    const killProc = () => {
      result.wasAborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000).unref();
    };
    if (options.signal) {
      if (options.signal.aborted) killProc();
      else options.signal.addEventListener("abort", killProc, { once: true });
    }

    // end() is intentional: Pi reads the whole prompt from stdin before executing it.
    sendPromptToStdin(proc.stdin, options.prompt);
  });
}
