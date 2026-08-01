import type { Message } from "@earendil-works/pi-ai";

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
}
