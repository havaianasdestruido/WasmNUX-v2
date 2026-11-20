import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CI benchmark policy', () => {
  it('records results without gating performance against runner-specific baselines', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('npm run bench:record');
    expect(workflow).not.toMatch(/npm run bench:gate/);
  });
});
