import net from 'node:net';
import { chromium } from 'playwright-core';
import type { AuthorizeOutcome, BrowserAuthorizer } from './login.js';

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

/** Is Chrome listening on its debug port, so a sign-in can be approved automatically? */
export function browserPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Where a sign-in link may point before this machine opens it. A relayed link
 * comes from another machine, and the browser here is signed in to Claude and
 * may click Authorize on its own, so a link anywhere else is never opened.
 */
const SIGN_IN_HOSTS = new Set(['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com']);

export function isAnthropicSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && SIGN_IN_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Claude Code's own OAuth client, and the page that shows the code to paste. */
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback';
/** Where a Claude subscription sign-in starts; the Console's own page is not one of them. */
const SUBSCRIPTION_AUTHORIZE_PAGES = new Set(['claude.com/cai/oauth/authorize', 'claude.ai/oauth/authorize']);

/**
 * Is this exactly a Claude subscription sign-in for Claude Code? Only such a
 * link is approved without the person seeing it, because approving clicks
 * through on whatever page the link opens. Any other link, even on an
 * Anthropic host (a settings page, a Console sign-in, another client), is
 * shown to the person to decide.
 */
export function isClaudeCodeSignIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    return (
      parsed.protocol === 'https:' &&
      SUBSCRIPTION_AUTHORIZE_PAGES.has(`${parsed.hostname}${parsed.pathname}`) &&
      params.get('client_id') === CLAUDE_CODE_CLIENT_ID &&
      params.get('redirect_uri') === MANUAL_REDIRECT &&
      params.get('response_type') === 'code'
    );
  } catch {
    return false;
  }
}

/**
 * The code Claude's paste prompt wants, read from the address of the page shown
 * after Authorize. That page displays the same `code#state` it carries in its
 * query, so nothing on the page itself has to be scraped.
 */
export function codeFromCallbackUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (`${parsed.origin}${parsed.pathname}` !== MANUAL_REDIRECT) return null;
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    return code && state ? `${code}#${state}` : null;
  } catch {
    return null;
  }
}

export interface ApprovalResult {
  outcome: AuthorizeOutcome;
  /** The pasteable `code#state`, when the browser got that far. */
  code?: string;
}

/** Approves a sign-in in this machine's browser and returns the code it produced. */
export interface SignInApprover {
  approve(input: { url: string; debugPort: number; timeoutMs: number }): Promise<ApprovalResult>;
}

/**
 * Open the link in the user's Chrome, click Authorize, and wait for the page
 * Anthropic shows afterwards to read the code from it. Closes only the tab it
 * opened, and disconnects, which for a browser reached over its debug port ends
 * the connection without closing the browser.
 */
export const cdpSignInApprover: SignInApprover = {
  async approve({ url, debugPort, timeoutMs }) {
    if (!isClaudeCodeSignIn(url)) return { outcome: 'failed' };
    const browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${debugPort}`)
      .catch(() => null);
    if (!browser) return { outcome: 'failed' };
    let result: ApprovalResult = { outcome: 'left-open' };
    try {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const button = page.getByRole('button', { name: /authorize|allow|continue|approve/i }).first();
      await button.waitFor({ state: 'visible', timeout: 15_000 });
      await button.click();
      await page.waitForURL((address) => codeFromCallbackUrl(address.toString()) !== null, {
        timeout: timeoutMs,
      });
      const code = codeFromCallbackUrl(page.url());
      if (code) {
        result = { outcome: 'authorized', code };
        await page.close().catch(() => {});
      }
    } catch {
      // Left open on purpose: the person can still approve there and paste the code.
    } finally {
      await browser.close().catch(() => {});
    }
    return result;
  },
};
