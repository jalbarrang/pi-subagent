import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareSubagentDispatch } from "../extensions/subagent/dispatch.js";
import {
  buildClaudeAgentArgs,
  resetClaudeCommandCache,
  resolveClaudeCommand,
  spawnClaudeAgent,
} from "../extensions/subagent/spawn-claude.js";
import { getFinalText } from "../extensions/subagent/agent-result-utils.js";

const tempDirs: string[] = [];

afterEach(() => {
  resetClaudeCommandCache();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Install an executable fake `claude` on PATH that emits canned stream-json lines. */
function installFakeClaude(script: string): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  tempDirs.push(dir);
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  fs.chmodSync(file, 0o755);
  return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
}

const SUCCESS_SCRIPT = `
const lines = [
  { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" },
  { type: "assistant", message: { model: "claude-sonnet-4-5", stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
    content: [ { type: "text", text: "Let me look." },
      { type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.ts" } } ] } },
  { type: "user", message: { content: [ { type: "tool_result", tool_use_id: "tu_1",
    content: [ { type: "text", text: "file body" } ], is_error: false } ] } },
  { type: "assistant", message: { model: "claude-sonnet-4-5", stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 6 },
    content: [ { type: "text", text: "hello from claude" } ] } },
  { type: "result", subtype: "success", is_error: false, result: "hello from claude",
    session_id: "s1", total_cost_usd: 0.0123, usage: { input_tokens: 30, output_tokens: 10 } },
];
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
  process.exit(0);
});
`;

const ERROR_SCRIPT = `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution",
    is_error: true, result: "boom", session_id: "s1" }) + "\\n");
  process.exit(1);
});
`;

describe("claude backend arg building", () => {
  it("uses headless stream-json with verbose and no tool flags without an allowlist", () => {
    const args = buildClaudeAgentArgs({ cwd: "/x", prompt: "hi" });
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
    expect(args).not.toContain("--allowedTools");
  });

  it("scopes an explicit tool allowlist and drops the bypass permission mode", () => {
    const args = buildClaudeAgentArgs({ cwd: "/x", prompt: "hi", tools: ["Read", "Grep"] });
    expect(args).toContain("--allowedTools");
    const index = args.indexOf("--allowedTools");
    expect(args.slice(index + 1, index + 3)).toEqual(["Read", "Grep"]);
    expect(args).not.toContain("bypassPermissions");
  });

  it("leaves an empty allowlist with no allowed tools and no bypass", () => {
    const args = buildClaudeAgentArgs({ cwd: "/x", prompt: "hi", tools: [] });
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("bypassPermissions");
  });

  it("forwards the model flag when provided", () => {
    expect(buildClaudeAgentArgs({ cwd: "/x", prompt: "hi", model: "haiku" })).toContain("--model");
  });
});

describe("claude backend dispatch routing", () => {
  it("preserves the backend selection through leaf preparation", () => {
    const prepared = prepareSubagentDispatch({ cwd: "/x", prompt: "hi", backend: "claude" }, {});
    expect(prepared.allowed).toBe(true);
    if (prepared.allowed) expect(prepared.options.backend).toBe("claude");
  });

  it("resolves a claude command from PATH before falling back to the bare name", () => {
    const env = installFakeClaude("process.exit(0)");
    expect(path.basename(resolveClaudeCommand(env))).toBe("claude");
  });
});

describe("claude backend stream translation", () => {
  it("normalizes assistant text, tool cycles, usage, and cost into a pi result", async () => {
    const env = installFakeClaude(SUCCESS_SCRIPT);
    resetClaudeCommandCache();
    const toolStarts: string[] = [];
    const toolResults: string[] = [];
    const result = await spawnClaudeAgent({
      cwd: process.cwd(),
      prompt: "do it",
      env,
      onToolExecutionStart: (event) => toolStarts.push(event.toolName),
      onToolResult: (message) =>
        toolResults.push(message.role === "toolResult" ? message.toolName : ""),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe("stop");
    expect(getFinalText(result)).toBe("hello from claude");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(30);
    expect(result.usage.output).toBe(10);
    expect(result.usage.cost).toBeCloseTo(0.0123, 6);
    expect(toolStarts).toEqual(["Read"]);
    expect(toolResults).toEqual(["Read"]);
  });

  it("marks an is_error result as a failed run with its message", async () => {
    const env = installFakeClaude(ERROR_SCRIPT);
    resetClaudeCommandCache();
    const result = await spawnClaudeAgent({ cwd: process.cwd(), prompt: "do it", env });
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("boom");
  });
});
