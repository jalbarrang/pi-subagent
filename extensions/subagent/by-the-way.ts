import { getFinalText, getPromptError } from "./agent-result-utils.js";
import type { PromptResult } from "./agent-runner-types.js";

export const MAX_BTW_OUTPUT_BYTES = 24 * 1024;
export const MAX_BTW_OUTPUT_LINES = 600;
export const BTW_OUTPUT_TRUNCATION_MARKER = "\n[output truncated by /btw]";

export interface BtwResultData {
  id: string;
  title: string;
  status: "completed" | "failed";
  prompt: string;
  answer: string;
  error?: string;
  truncated: boolean;
  model?: string;
}

/** Derive a compact, Unicode-safe title from the first meaningful prompt line. */
export function deriveBtwTitle(question: string): string {
  const firstLine = question.split("\n").find((line) => line.trim());
  const title = firstLine?.trim().replace(/\s+/g, " ") || "by the way";
  const codePoints = Array.from(title);
  return codePoints.length <= 60 ? title : `${codePoints.slice(0, 59).join("")}…`;
}

/** Bound durable display output without splitting a UTF-8 code point. */
export function capBtwOutput(output: string): { content: string; truncated: boolean } {
  const lines = output.split("\n");
  const needsTruncation =
    lines.length > MAX_BTW_OUTPUT_LINES || Buffer.byteLength(output, "utf8") > MAX_BTW_OUTPUT_BYTES;
  if (!needsTruncation) return { content: output, truncated: false };
  const lineBounded = lines.slice(0, MAX_BTW_OUTPUT_LINES - 1).join("\n");

  const markerBytes = Buffer.byteLength(BTW_OUTPUT_TRUNCATION_MARKER, "utf8");
  const bytes = Buffer.from(lineBounded, "utf8");
  let end = Math.min(bytes.length, MAX_BTW_OUTPUT_BYTES - markerBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    content: `${bytes.subarray(0, end).toString("utf8")}${BTW_OUTPUT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export function createBtwResultData(
  id: string,
  title: string,
  result: PromptResult,
): BtwResultData {
  const error = getPromptError(result);
  const output = capBtwOutput(error ?? getFinalText(result));
  return {
    id,
    title,
    status: error ? "failed" : "completed",
    prompt: result.prompt,
    answer: output.content,
    error: error ? output.content : undefined,
    truncated: output.truncated,
    model: result.model,
  };
}

export function createBtwFailureData(
  id: string,
  title: string,
  prompt: string,
  error: unknown,
): BtwResultData {
  const message = error instanceof Error ? error.message : String(error);
  const output = capBtwOutput(message || "(no output)");
  return {
    id,
    title,
    status: "failed",
    prompt,
    answer: output.content,
    error: output.content,
    truncated: output.truncated,
  };
}
