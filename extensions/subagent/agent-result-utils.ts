import type { PromptResult } from "./agent-runner-types.js";

export const MAX_PREVIOUS_OUTPUT_BYTES = 64 * 1024;
export const PREVIOUS_OUTPUT_TRUNCATION_MARKER = "\n\n[previous output truncated by pi-subagent]\n";

/** Bound raw previous output without splitting a UTF-8 code point. */
export function capPreviousOutput(output: string): string {
  const buffer = Buffer.from(output, "utf8");
  if (buffer.byteLength <= MAX_PREVIOUS_OUTPUT_BYTES) return output;
  const markerBytes = Buffer.byteLength(PREVIOUS_OUTPUT_TRUNCATION_MARKER, "utf8");
  let prefixEnd = MAX_PREVIOUS_OUTPUT_BYTES - markerBytes;
  while (prefixEnd > 0 && (buffer[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
  return `${buffer.subarray(0, prefixEnd).toString("utf8")}${PREVIOUS_OUTPUT_TRUNCATION_MARKER}`;
}

export function getFinalText(result: PromptResult, fallback = "(no output)"): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const msg = result.messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return fallback;
}

export function getPromptError(result: PromptResult): string | undefined {
  if (result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted")
    return undefined;
  return result.errorMessage || result.stderr || getFinalText(result) || "(no output)";
}
