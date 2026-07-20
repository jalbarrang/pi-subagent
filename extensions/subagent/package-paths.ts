/**
 * Resolve pi package paths so agent discovery can see package-provided
 * prompts (e.g. the scouts and workers this package ships). Shared by the
 * subagent tool surfaces and the background workflow bridge — a workflow that
 * cannot see package agents fails its phases with "Unknown agent".
 */

import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ResolvedPaths,
} from '@earendil-works/pi-coding-agent';

export async function resolvePackagePaths(cwd: string): Promise<ResolvedPaths | undefined> {
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    return await packageManager.resolve();
  } catch {
    return undefined;
  }
}
