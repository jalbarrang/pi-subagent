import { describe, expect, it } from "bun:test";
import { prepareSubagentDispatch, resolveBackend } from "../extensions/subagent/dispatch.js";
import type { SpawnPiAgentOptions } from "../extensions/subagent/spawn-utils.js";

function run(overrides: Partial<SpawnPiAgentOptions>): SpawnPiAgentOptions {
  return { cwd: "/fixture", prompt: "do it", ...overrides };
}

describe("backend resolution", () => {
  it("routes a bare claude model to the claude backend", () => {
    expect(resolveBackend(run({ model: "claude-sonnet-4-5" }))).toBe("claude");
  });

  it("keeps an explicit backend even when it contradicts the model", () => {
    expect(resolveBackend(run({ model: "claude-sonnet-4-5", backend: "pi" }))).toBe("pi");
    expect(resolveBackend(run({ model: "openai-codex/gpt-5.6-luna", backend: "claude" }))).toBe(
      "claude",
    );
  });

  it("leaves provider-qualified ids alone so Pi owns the routing", () => {
    expect(resolveBackend(run({ model: "anthropic/claude-sonnet-4-5" }))).toBeUndefined();
  });

  it("leaves non-claude and absent models alone", () => {
    expect(resolveBackend(run({ model: "openai-codex/gpt-5.6-luna" }))).toBeUndefined();
    expect(resolveBackend(run({}))).toBeUndefined();
  });

  it("applies the inference before dispatch reads the backend", () => {
    const prepared = prepareSubagentDispatch(run({ model: "claude-opus-5" }), { PATH: "/fixture" });
    expect(prepared.allowed).toBe(true);
    if (prepared.allowed) expect(prepared.options.backend).toBe("claude");
  });
});
