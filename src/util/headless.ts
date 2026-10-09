/**
 * Is there nobody sitting at a browser on this machine for this session?
 *
 * True over SSH, and on Linux or BSD with no display server. It is about the
 * session rather than the machine: a desktop reached over SSH has a browser, but
 * not one in front of the person typing.
 */
export function isHeadlessSession(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return !env.DISPLAY && !env.WAYLAND_DISPLAY;
  }
  return false;
}
