import { describe, expect, it } from "bun:test";
import subagentExtension from "../extensions/subagent/index.js";
import { dispatchSubagent, prepareSubagentDispatch } from "../extensions/subagent/dispatch.js";
import {
  AGENT_LEAF_ENV,
  AGENT_LEAF_VALUE,
  CHILD_ORCHESTRATION_TOOL_NAMES,
  createAgentLeafEnvironment,
  isAgentLeafEnvironment,
} from "../extensions/subagent/leaf-policy.js";
import { buildPiAgentArgs, sendPromptToStdin } from "../extensions/subagent/spawn-utils.js";

function restoreLeafMarker(previous: string | undefined): void {
  if (previous === undefined) delete process.env[AGENT_LEAF_ENV];
  else process.env[AGENT_LEAF_ENV] = previous;
}

describe("leaf agent policy", () => {
  it("marks child environments without dropping parent values", () => {
    const child = createAgentLeafEnvironment({ PATH: "/fixture", TOKEN: "secret" });
    expect(child).toEqual({
      PATH: "/fixture",
      TOKEN: "secret",
      [AGENT_LEAF_ENV]: AGENT_LEAF_VALUE,
    });
    expect(isAgentLeafEnvironment(child)).toBe(true);
  });

  it("marks prompt-native child options before spawning", () => {
    const prepared = prepareSubagentDispatch(
      { cwd: "/fixture", prompt: "complete prompt", label: "fixture" },
      { PATH: "/fixture" },
    );
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) throw new Error("dispatch was unexpectedly denied");
    expect(prepared.options.env?.[AGENT_LEAF_ENV]).toBe(AGENT_LEAF_VALUE);
  });

  it("uses JSON print mode, stdin prompt transport, and orchestration exclusions", () => {
    const args = buildPiAgentArgs({
      cwd: "/fixture",
      prompt: "exact prompt",
      tools: ["read", "subagent"],
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-prompt-templates",
        "--tools",
        "read,subagent",
        "--exclude-tools",
        CHILD_ORCHESTRATION_TOOL_NAMES.join(","),
      ]),
    );
    expect(args.join(" ")).not.toContain("exact prompt");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("treats an explicit empty tool list as no tools", () => {
    const args = buildPiAgentArgs({ cwd: "/fixture", prompt: "exact prompt", tools: [] });
    expect(args).toContain("--no-tools");
    expect(args).not.toContain("--tools");
  });

  it("transports the exact complete prompt and closes stdin", () => {
    const writes: Array<{ prompt: string; encoding?: BufferEncoding }> = [];
    sendPromptToStdin(
      {
        end(prompt, encoding) {
          writes.push({ prompt, encoding });
        },
      },
      "Keep this exact:\nTask: not added by the engine.",
    );
    expect(writes).toEqual([
      { prompt: "Keep this exact:\nTask: not added by the engine.", encoding: "utf8" },
    ]);
  });

  it("rejects backend dispatch from an already marked process", async () => {
    const previous = process.env[AGENT_LEAF_ENV];
    process.env[AGENT_LEAF_ENV] = AGENT_LEAF_VALUE;
    try {
      const result = await dispatchSubagent({
        cwd: "/fixture",
        prompt: "delegate again",
        label: "worker",
      });
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("spawned agents are leaves");
    } finally {
      restoreLeafMarker(previous);
    }
  });

  it("registers no extension surfaces in a marked process", () => {
    const previous = process.env[AGENT_LEAF_ENV];
    process.env[AGENT_LEAF_ENV] = AGENT_LEAF_VALUE;
    try {
      const forbiddenPiAccess = new Proxy(
        {},
        {
          get() {
            throw new Error("marked extension accessed the Pi registration API");
          },
        },
      );
      expect(() => subagentExtension(forbiddenPiAccess as never)).not.toThrow();
    } finally {
      restoreLeafMarker(previous);
    }
  });
});
