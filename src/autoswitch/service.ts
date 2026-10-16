/**
 * The service that keeps the watcher running.
 *
 * ccx prints the file and says where it goes; it installs nothing. A service
 * is the one thing here that keeps running after the terminal closes and
 * comes back after a reboot, so putting it in place stays a step the user
 * takes, and can read first.
 *
 * Each form restarts the watcher when it exits. That matters beyond crashes:
 * the watcher ends itself when a newer ccx has been installed, and the restart
 * is what puts it on the new one.
 */

export const SERVICE_NAME = 'ccx-autoswitch';
export const LAUNCHD_LABEL = 'ccx.autoswitch';

export interface ServicePrograms {
  /** The node that runs ccx here. */
  node: string;
  /** ccx's entry point. */
  cli: string;
  /** `CLAUDE_AUTO_SWITCH_HOME`, when ccx keeps its files somewhere other than the default. */
  home?: string;
}

/** A path neither service file can carry: a line break ends the line it sits on. */
function assertOneLine(value: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`cannot write ${JSON.stringify(value)} into a service file`);
  }
}

/**
 * One word of a systemd line: quoted, with what systemd reads inside quotes
 * escaped (a backslash, a quote, and % which starts a specifier). On a command
 * line `$` starts a variable as well.
 */
function systemdWord(value: string, commandLine = false): string {
  assertOneLine(value);
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${commandLine ? escaped.replaceAll('$', '$$$$') : escaped}"`;
}

/** A systemd user unit: `~/.config/systemd/user/ccx-autoswitch.service`. */
export function systemdUnit(programs: ServicePrograms): string {
  const lines = [
    '[Unit]',
    'Description=ccx auto-switch watcher: moves to another Claude account before one runs out',
    'After=network-online.target',
    // Never give up restarting: a watcher that stays down protects nothing.
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    ...(programs.home ? [`Environment=${systemdWord(`CLAUDE_AUTO_SWITCH_HOME=${programs.home}`)}`] : []),
    `ExecStart=${systemdWord(programs.node, true)} ${systemdWord(programs.cli, true)} autoswitch run --by service`,
    // What it would print names accounts, and a journal is read more widely
    // than the owner-only files ccx keeps. `ccx history` has the same lines.
    'StandardOutput=null',
    'StandardError=journal',
    'Restart=always',
    'RestartSec=15',
    // It reads one number a minute; anything else on the machine comes first.
    'Nice=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

function xmlText(value: string): string {
  assertOneLine(value);
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A launchd agent: `~/Library/LaunchAgents/ccx.autoswitch.plist`. */
export function launchdPlist(programs: ServicePrograms): string {
  const args = [programs.node, programs.cli, 'autoswitch', 'run', '--by', 'service'];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${xmlText(arg)}</string>`),
    '  </array>',
    ...(programs.home
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          '    <key>CLAUDE_AUTO_SWITCH_HOME</key>',
          `    <string>${xmlText(programs.home)}</string>`,
          '  </dict>',
        ]
      : []),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>15</integer>',
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

export interface ServiceGuide {
  /** Where the file goes, as the user would type it. */
  file: string | null;
  /** The file's contents; null where there is no file to write. */
  contents: string | null;
  /** What to run, in order, to start it and to stop it. */
  start: string[];
  stop: string[];
  /** What a watchdog on another machine can run here to start it again. */
  restart: string | null;
}

/** What to do on this platform to keep the watcher running. */
export function serviceGuide(platform: NodeJS.Platform, programs: ServicePrograms): ServiceGuide {
  if (platform === 'win32') {
    assertOneLine(programs.node);
    assertOneLine(programs.cli);
    return {
      file: null,
      contents: null,
      start: [
        `schtasks /Create /SC ONLOGON /TN "ccx autoswitch" /TR "\\"${programs.node}\\" \\"${programs.cli}\\" autoswitch run --by service"`,
        'schtasks /Run /TN "ccx autoswitch"',
      ],
      stop: ['schtasks /End /TN "ccx autoswitch"', 'schtasks /Delete /TN "ccx autoswitch" /F'],
      restart: null,
    };
  }
  if (platform === 'darwin') {
    const file = `~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    return {
      file,
      contents: launchdPlist(programs),
      start: [`launchctl bootstrap gui/$(id -u) ${file}`],
      stop: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`],
      restart: `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`,
    };
  }
  return {
    file: `~/.config/systemd/user/${SERVICE_NAME}.service`,
    contents: systemdUnit(programs),
    start: [
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SERVICE_NAME}`,
      // Without this a user service stops at logout, and on a server nobody is logged in.
      'loginctl enable-linger "$USER"',
    ],
    stop: [`systemctl --user disable --now ${SERVICE_NAME}`],
    restart: `systemctl --user restart ${SERVICE_NAME}`,
  };
}
