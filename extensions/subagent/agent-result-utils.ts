import type { PromptResult } from "./agent-runner-types.js";

export const MAX_PREVIOUS_OUTPUT_BYTES = 64 * 1024;
export const PREVIOUS_OUTPUT_TRUNCATION_MARKER = "\n\n[previous output truncated by pi-subagent]\n";
export const MAX_MODEL_OUTPUT_BYTES = 48 * 1024;
export const MAX_MODEL_OUTPUT_LINES = 600;
export const MAX_PARALLEL_CHILD_OUTPUT_BYTES = 12 * 1024;
export const MAX_PARALLEL_CHILD_OUTPUT_LINES = 160;
export const MODEL_OUTPUT_TRUNCATION_MARKER = "\n[output truncated by pi-subagent]";
export const MAX_WORKFLOW_SNAPSHOT_BYTES = 48 * 1024;
export const MAX_WORKFLOW_SNAPSHOT_LINES = 600;
export const WORKFLOW_SNAPSHOT_TRUNCATION_MARKER = "[workflow output truncated by pi-subagent]";

/** Bound raw previous output without splitting a UTF-8 code point. */
export function capPreviousOutput(output: string): string {
  const buffer = Buffer.from(output, "utf8");
  if (buffer.byteLength <= MAX_PREVIOUS_OUTPUT_BYTES) return output;
  const markerBytes = Buffer.byteLength(PREVIOUS_OUTPUT_TRUNCATION_MARKER, "utf8");
  let prefixEnd = MAX_PREVIOUS_OUTPUT_BYTES - markerBytes;
  while (prefixEnd > 0 && (buffer[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
  return `${buffer.subarray(0, prefixEnd).toString("utf8")}${PREVIOUS_OUTPUT_TRUNCATION_MARKER}`;
}

/** Bound model-visible output by UTF-8 bytes and lines with an explicit marker. */
export interface TextBudget {
  bytes: number;
  lines: number;
}

/** Consume an aggregate response budget while preserving UTF-8 boundaries and a truncation marker. */
export function capSnapshotOutput(output: string, budget: TextBudget): string | undefined {
  if (!output) return output;
  const outputBytes = Buffer.byteLength(output, "utf8");
  const outputLines = output.split("\n").length;
  if (outputBytes <= budget.bytes && outputLines <= budget.lines) {
    budget.bytes -= outputBytes;
    budget.lines -= outputLines;
    return output;
  }

  const marker = WORKFLOW_SNAPSHOT_TRUNCATION_MARKER;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (budget.bytes < markerBytes || budget.lines < 1) return undefined;
  const bodyLines = output
    .split("\n")
    .slice(0, Math.max(0, budget.lines - 1))
    .join("\n");
  const suffix = bodyLines ? `\n${marker}` : marker;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const bodyBytes = Buffer.from(bodyLines, "utf8");
  let end = Math.min(bodyBytes.length, Math.max(0, budget.bytes - suffixBytes));
  while (end > 0 && (bodyBytes[end]! & 0xc0) === 0x80) end--;
  const body = bodyBytes.subarray(0, end).toString("utf8");
  const content = body ? `${body}\n${marker}` : marker;
  budget.bytes -= Buffer.byteLength(content, "utf8");
  budget.lines -= content.split("\n").length;
  return content;
}

export function capModelOutput(
  output: string,
  maxBytes = MAX_MODEL_OUTPUT_BYTES,
  maxLines = MAX_MODEL_OUTPUT_LINES,
): { content: string; truncated: boolean } {
  const lines = output.split("\n");
  const needsTruncation = lines.length > maxLines || Buffer.byteLength(output, "utf8") > maxBytes;
  if (!needsTruncation) return { content: output, truncated: false };
  const lineBounded = lines.slice(0, Math.max(1, maxLines - 1)).join("\n");
  const markerBytes = Buffer.byteLength(MODEL_OUTPUT_TRUNCATION_MARKER, "utf8");
  const bytes = Buffer.from(lineBounded, "utf8");
  let end = Math.min(bytes.length, Math.max(0, maxBytes - markerBytes));
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    content: `${bytes.subarray(0, end).toString("utf8")}${MODEL_OUTPUT_TRUNCATION_MARKER}`,
    truncated: true,
  };
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
