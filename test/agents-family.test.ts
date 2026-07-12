import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgents } from '../extensions/subagent/agents.js';

function writePrompt(promptsDir: string, name: string, family?: string): void {
  const familyLine = family === undefined ? '' : `family: ${family}\n`;
  fs.writeFileSync(
    path.join(promptsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} fixture\n${familyLine}---\n\nFixture prompt.\n`,
  );
}

describe('agent family discovery', () => {
  it('parses valid families and leaves missing or invalid values ungrouped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-family-'));
    const promptsDir = path.join(root, '.pi', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });

    try {
      writePrompt(promptsDir, 'scout-agent', 'scout');
      writePrompt(promptsDir, 'consult-agent', 'CONSULT');
      writePrompt(promptsDir, 'worker-agent', 'worker');
      writePrompt(promptsDir, 'missing-family');
      writePrompt(promptsDir, 'invalid-family', 'reviewer');

      const discovered = discoverAgents(path.join(root, 'nested'), 'project').agents;
      const families = Object.fromEntries(discovered.map((agent) => [agent.name, agent.family]));

      expect(families).toEqual({
        'scout-agent': 'scout',
        'consult-agent': 'consult',
        'worker-agent': 'worker',
        'missing-family': undefined,
        'invalid-family': undefined,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
