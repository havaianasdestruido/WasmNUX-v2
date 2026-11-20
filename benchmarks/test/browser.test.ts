import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: (path: string) =>
    path === '/tmp/wnx-browser-cache' || path === '/tmp/wnx-browser-cache/chromium-123/chrome-linux64/chrome',
  readdirSync: () => ['chromium-123'],
}));

import { findBrowser } from '../src/browser.ts';

describe('browser discovery', () => {
  it('finds the current Playwright Chromium linux64 layout', () => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/tmp/wnx-browser-cache');
    vi.stubEnv('WNX_BROWSER', '');
    vi.stubEnv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', '');
    try {
      expect(findBrowser()).toBe('/tmp/wnx-browser-cache/chromium-123/chrome-linux64/chrome');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
