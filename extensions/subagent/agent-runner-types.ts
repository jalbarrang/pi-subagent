import type { Message } from "@earendil-works/pi-ai";

/** Agent runtimes a child prompt can run on. `pi` is the default. */
export const BACKEND_NAMES = ["pi", "claude"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];
export const DEFAULT_BACKEND: BackendName = "pi";

export function isBackendName(value: unknown): value is BackendName {
  return typeof value === "string" && (BACKEND_NAMES as readonly string[]).includes(value);
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface PromptResult {
  label?: string;
  prompt: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface PromptRun {
  prompt: string;
  label?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  /** Agent runtime for this run. Defaults to `pi`. */
  backend?: BackendName;
}
