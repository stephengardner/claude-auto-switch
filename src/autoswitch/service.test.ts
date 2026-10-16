import { describe, it, expect } from 'vitest';
import { LAUNCHD_LABEL, SERVICE_NAME, launchdPlist, serviceGuide, systemdUnit } from './service.js';

const programs = { node: '/opt/node/bin/node', cli: '/opt/ccx/dist/cli.js' };

describe('the systemd unit', () => {
  it('runs the watcher with this node and this ccx, and starts it again whenever it exits', () => {
    const unit = systemdUnit(programs);
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/ccx/dist/cli.js" autoswitch run --by service\n');
    expect(unit).toContain('Restart=always\n');
    // The lines it prints name accounts; the journal is not the place for them.
    expect(unit).toContain('StandardOutput=null\nStandardError=journal\n');
    expect(unit).toContain('StartLimitIntervalSec=0\n');
    expect(unit).toContain('WantedBy=default.target\n');
    expect(unit).not.toContain('Environment=');
  });

  it('carries the ccx home when it is not the default one', () => {
    expect(systemdUnit({ ...programs, home: '/srv/ccx home' })).toContain(
      'Environment="CLAUDE_AUTO_SWITCH_HOME=/srv/ccx home"\n',
    );
  });

  it('escapes what systemd would read as something else', () => {
    const unit = systemdUnit({ node: '/opt/my node/100%/$n/"q"/node', cli: 'C:\\ccx\\cli.js' });
    expect(unit).toContain('ExecStart="/opt/my node/100%%/$$n/\\"q\\"/node" "C:\\\\ccx\\\\cli.js" autoswitch run');
  });

  it('refuses a path with a line break in it, which would end the line', () => {
    expect(() => systemdUnit({ ...programs, cli: '/opt/ccx\nExecStartPre=/bin/evil' })).toThrow('service file');
  });
});

describe('the launchd agent', () => {
  it('runs the watcher at login and keeps it running', () => {
    const plist = launchdPlist(programs);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(
      ['    <string>/opt/node/bin/node</string>', '    <string>/opt/ccx/dist/cli.js</string>', '    <string>autoswitch</string>', '    <string>run</string>'].join('\n'),
    );
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).not.toContain('EnvironmentVariables');
  });

  it('escapes a path for XML, and carries the ccx home when given', () => {
    const plist = launchdPlist({ node: '/opt/a&b/<node>', cli: programs.cli, home: '/srv/ccx' });
    expect(plist).toContain('<string>/opt/a&amp;b/&lt;node&gt;</string>');
    expect(plist).toMatch(/<key>CLAUDE_AUTO_SWITCH_HOME<\/key>\s*<string>\/srv\/ccx<\/string>/);
  });
});

describe('what to do on each platform', () => {
  it('is a user unit on Linux, kept running after logout', () => {
    const guide = serviceGuide('linux', programs);
    expect(guide.file).toBe(`~/.config/systemd/user/${SERVICE_NAME}.service`);
    expect(guide.contents).toBe(systemdUnit(programs));
    expect(guide.start).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SERVICE_NAME}`,
      'loginctl enable-linger "$USER"',
    ]);
    expect(guide.restart).toBe(`systemctl --user restart ${SERVICE_NAME}`);
  });

  it('is a launch agent on macOS', () => {
    const guide = serviceGuide('darwin', programs);
    expect(guide.file).toBe(`~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(guide.contents).toBe(launchdPlist(programs));
    expect(guide.start).toEqual([`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`]);
    expect(guide.restart).toBe(`launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`);
  });

  it('is a scheduled task on Windows, with no file to write', () => {
    const guide = serviceGuide('win32', { node: 'C:\\node\\node.exe', cli: 'C:\\ccx\\dist\\cli.js' });
    expect(guide.file).toBeNull();
    expect(guide.contents).toBeNull();
    expect(guide.start[0]).toBe(
      'schtasks /Create /SC ONLOGON /TN "ccx autoswitch" /TR "\\"C:\\node\\node.exe\\" \\"C:\\ccx\\dist\\cli.js\\" autoswitch run --by service"',
    );
    expect(guide.restart).toBeNull();
  });
});
