import { chromium } from 'playwright-core';
import type { BrowserAuthorizer } from './login.js';

/**
 * Real browser authorizer: connect to the user's already-running Chrome over the
 * DevTools protocol (start Chrome with `--remote-debugging-port=<port>`), find
 * the OAuth Authorize control, and click it using the browser's existing
 * sessions. Best-effort by design: if it cannot connect or find the button, it
 * leaves the browser on the page so the user can finish one step. It never
 * closes the user's browser.
 */
export const cdpBrowserAuthorizer: BrowserAuthorizer = {
  async authorize({ url, debugPort }) {
    const browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${debugPort}`)
      .catch(() => null);
    if (!browser) return 'failed';

    try {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = url ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      const button = page.getByRole('button', { name: /authorize|allow|continue|approve/i }).first();
      await button.waitFor({ state: 'visible', timeout: 15_000 });
      await button.click();
      return 'authorized';
    } catch {
      return 'left-open';
    }
  },
};
