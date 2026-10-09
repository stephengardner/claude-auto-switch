import { describe, it, expect } from 'vitest';
import { codeFromCallbackUrl, isAnthropicSignInUrl, isClaudeCodeSignIn } from './browser.js';

describe('isAnthropicSignInUrl', () => {
  it('accepts the sign-in pages Claude links to', () => {
    expect(isAnthropicSignInUrl('https://claude.com/cai/oauth/authorize?code=true')).toBe(true);
    expect(isAnthropicSignInUrl('https://platform.claude.com/oauth/authorize?x=1')).toBe(true);
    expect(isAnthropicSignInUrl('https://claude.ai/oauth/authorize')).toBe(true);
  });

  it('refuses any other host, a look-alike, or plain http', () => {
    expect(isAnthropicSignInUrl('https://evil.example/oauth/authorize')).toBe(false);
    expect(isAnthropicSignInUrl('https://claude.com.evil.example/oauth')).toBe(false);
    expect(isAnthropicSignInUrl('https://evilclaude.com/oauth')).toBe(false);
    expect(isAnthropicSignInUrl('http://claude.com/cai/oauth/authorize')).toBe(false);
    expect(isAnthropicSignInUrl('not a url')).toBe(false);
  });
});

describe('isClaudeCodeSignIn', () => {
  const real =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
    '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
    '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=c&code_challenge_method=S256&state=s';
  const swap = (from: string, to: string) => real.replace(from, to);

  it('accepts the sign-in claude prints for a Claude subscription', () => {
    expect(isClaudeCodeSignIn(real)).toBe(true);
  });

  it('refuses the Console sign-in, another client, another redirect, or another response', () => {
    expect(isClaudeCodeSignIn(swap('https://claude.com/cai/oauth/authorize', 'https://platform.claude.com/oauth/authorize'))).toBe(false);
    expect(isClaudeCodeSignIn(swap('9d1c250a-e61b-44d9-88ed-5944d1962f5e', 'someone-else'))).toBe(false);
    expect(isClaudeCodeSignIn(swap('platform.claude.com%2Foauth%2Fcode%2Fcallback', 'evil.example%2Fcb'))).toBe(false);
    expect(isClaudeCodeSignIn(swap('response_type=code', 'response_type=token'))).toBe(false);
  });

  it('refuses a link that repeats a key it checks', () => {
    expect(isClaudeCodeSignIn(`${real}&client_id=other-client`)).toBe(false);
    expect(isClaudeCodeSignIn(`${real}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb`)).toBe(false);
    expect(isClaudeCodeSignIn(`${real}&response_type=token`)).toBe(false);
  });

  it('refuses any other page on an Anthropic host', () => {
    expect(isClaudeCodeSignIn('https://claude.ai/settings/billing')).toBe(false);
    expect(isClaudeCodeSignIn('https://console.anthropic.com/settings/keys')).toBe(false);
    expect(isClaudeCodeSignIn('https://claude.ai/logout')).toBe(false);
  });
});

describe('codeFromCallbackUrl', () => {
  it('reads code#state from the page shown after Authorize', () => {
    expect(
      codeFromCallbackUrl('https://platform.claude.com/oauth/code/callback?code=abc123&state=st-9'),
    ).toBe('abc123#st-9');
  });

  it('has no code before the redirect, or when sign-in was declined', () => {
    expect(codeFromCallbackUrl('https://claude.com/cai/oauth/authorize?code=true&state=s')).toBeNull();
    expect(
      codeFromCallbackUrl('https://platform.claude.com/oauth/code/callback?error=access_denied&state=s'),
    ).toBeNull();
  });

  it('takes a code only from an Anthropic page', () => {
    expect(codeFromCallbackUrl('https://evil.example/oauth/code/callback?code=a&state=b')).toBeNull();
  });
});
