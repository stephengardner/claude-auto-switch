import { describe, it, expect } from 'vitest';
import { isHeadlessSession } from './headless.js';

describe('isHeadlessSession', () => {
  it('is headless over SSH on any platform', () => {
    expect(isHeadlessSession({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, 'darwin')).toBe(true);
    expect(isHeadlessSession({ SSH_TTY: '/dev/pts/3' }, 'win32')).toBe(true);
    expect(isHeadlessSession({ SSH_CLIENT: '10.0.0.2 51000 22' }, 'linux')).toBe(true);
  });

  it('is headless on Linux with no display server', () => {
    expect(isHeadlessSession({}, 'linux')).toBe(true);
  });

  it('has a browser on a Linux desktop', () => {
    expect(isHeadlessSession({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadlessSession({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
  });

  it('has a browser on a Mac or Windows desktop', () => {
    expect(isHeadlessSession({}, 'darwin')).toBe(false);
    expect(isHeadlessSession({}, 'win32')).toBe(false);
  });
});
