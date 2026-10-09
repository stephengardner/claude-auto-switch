import { describe, it, expect } from 'vitest';
import { codeFromCallbackUrl, isAnthropicSignInUrl } from './browser.js';

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
