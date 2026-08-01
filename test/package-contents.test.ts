import { describe, expect, it } from "bun:test";
import manifest from "../package.json";

describe("package boundary", () => {
  it("exports only the extension and allowlists no persona resources", () => {
    expect(manifest.pi).toEqual({ extensions: ["./extensions/subagent"] });
    expect(manifest.files).toEqual(["extensions/subagent", "README.md", "CHANGELOG.md", "LICENSE"]);
    expect(JSON.stringify(manifest)).not.toContain("cursor");
    expect(JSON.stringify(manifest)).not.toContain("prompts");
    expect(JSON.stringify(manifest)).not.toContain("skills");
  });
});
