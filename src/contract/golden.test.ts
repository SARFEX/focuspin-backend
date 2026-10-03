import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { validateMagicContent } from './index.ts';
import type { MagicCommand } from './index.ts';

interface GoldenExpectation {
  ok: boolean;
  commands?: MagicCommand[];
  issue_codes?: string[];
}

interface GoldenFixture {
  name: string;
  model_output: string;
  expect: GoldenExpectation;
}

const goldenDir = join(import.meta.dir, '..', '..', 'contract', 'golden');
const files = [...new Bun.Glob('*.json').scanSync({ cwd: goldenDir })].sort();

describe('golden fixtures', () => {
  test('at least 25 fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  for (const file of files) {
    test(file, async () => {
      const fixture = (await Bun.file(join(goldenDir, file)).json()) as GoldenFixture;
      const result = validateMagicContent(fixture.model_output);
      if (fixture.expect.ok) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const expectedCommands = fixture.expect.commands;
        expect(expectedCommands).toBeDefined();
        if (expectedCommands === undefined) return;
        expect(result.commands).toEqual(expectedCommands);
        // canonicalJson must carry exactly the normalized commands.
        const canonical = JSON.parse(result.canonicalJson) as { commands: MagicCommand[] };
        expect(canonical.commands).toEqual(expectedCommands);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const expectedCodes = fixture.expect.issue_codes;
        expect(expectedCodes).toBeDefined();
        if (expectedCodes === undefined) return;
        expect(result.issues.map((issue) => issue.code)).toEqual(expectedCodes);
      }
    });
  }
});
