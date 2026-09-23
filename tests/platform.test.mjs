import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileManagerName, folderPickerCommand, folderPickerError, launchDetached, openCommand, resolveLavishBin, revealCommand } from '../scripts/platform.mjs';

const root = process.cwd();
const port = 45_000 + (process.pid % 1_000);
const api = `http://127.0.0.1:${port}/api`;
const linuxOnly = { skip: process.platform === 'darwin' && 'exercises the Linux branches' };
let service;
let fixture;
let lavishFile;
let revealLog;

const only = (...names) => (name) => (names.includes(name) ? `/usr/bin/${name}` : null);

test('resolves lavish-axi from LAVISH_AXI_BIN, then PATH, then Homebrew', () => {
  assert.equal(resolveLavishBin({ env: { LAVISH_AXI_BIN: '/custom/lavish-axi' }, lookup: only('lavish-axi') }), '/custom/lavish-axi');
  assert.equal(resolveLavishBin({ env: {}, lookup: only('lavish-axi') }), '/usr/bin/lavish-axi');
  assert.equal(resolveLavishBin({ env: {}, lookup: only() }), '/opt/homebrew/bin/lavish-axi');
});

test('keeps macOS open, reveal, and Finder behavior', () => {
  assert.deepEqual(openCommand('/tmp/a.html', 'darwin'), ['/usr/bin/open', ['/tmp/a.html']]);
  assert.deepEqual(revealCommand('/tmp/p/a.html', 'darwin'), ['/usr/bin/open', ['-R', '/tmp/p/a.html']]);
  assert.equal(fileManagerName('darwin'), 'Finder');
  const [command, args] = folderPickerCommand('Pick "one"', { platform: 'darwin', lookup: only('zenity', 'kdialog') });
  assert.equal(command, '/usr/bin/osascript');
  assert.deepEqual(args, ['-e', 'POSIX path of (choose folder with prompt "Pick \\"one\\"")']);
});

test('uses xdg-open on Linux and reveals the containing folder', () => {
  assert.deepEqual(openCommand('/tmp/a.html', 'linux'), ['xdg-open', ['/tmp/a.html']]);
  assert.deepEqual(revealCommand('/tmp/p/a.html', 'linux'), ['xdg-open', ['/tmp/p']]);
  assert.equal(fileManagerName('linux'), 'file manager');
});

test('picks zenity, then kdialog, then no picker on Linux', () => {
  assert.deepEqual(folderPickerCommand('Pick', { platform: 'linux', lookup: only('zenity', 'kdialog') }), ['zenity', ['--file-selection', '--directory', '--title=Pick']]);
  assert.deepEqual(folderPickerCommand('Pick', { platform: 'linux', lookup: only('kdialog') }), ['kdialog', ['--getexistingdirectory', os.homedir(), '--title', 'Pick']]);
  assert.equal(folderPickerCommand('Pick', { platform: 'linux', lookup: only() }), null);
});

test('treats a Linux picker exit code 1 as a cancel even with GTK noise on stderr', () => {
  const gtkNoise = 'Gtk-Message: 10:00:00.000: GtkDialog mapped without a transient parent. This is discouraged.\n';
  assert.equal(folderPickerError(1, gtkNoise, 'linux'), 'Folder selection cancelled.');
  assert.equal(folderPickerError(1, '', 'linux'), 'Folder selection cancelled.');
  assert.equal(folderPickerError(255, 'cannot open display\n', 'linux'), 'cannot open display');
});

test('keeps macOS picker cancel detection', () => {
  assert.equal(folderPickerError(1, 'execution error: User canceled. (-128)', 'darwin'), 'Folder selection cancelled.');
  assert.equal(folderPickerError(1, '', 'darwin'), 'Folder selection cancelled.');
  assert.equal(folderPickerError(1, 'execution error: Not authorized', 'darwin'), 'execution error: Not authorized');
});

test('reports a missing launcher instead of crashing', async () => {
  await assert.rejects(launchDetached(['/nonexistent/lavish-launcher', []]), /\/nonexistent\/lavish-launcher is not installed\./);
});

before(async () => {
  if (process.platform === 'darwin') return;
  fixture = await mkdtemp(path.join(os.tmpdir(), 'lavish-tracker-platform-'));
  const project = path.join(fixture, 'Project');
  const stateDir = path.join(fixture, 'lavish-state');
  const configDir = path.join(fixture, 'tracker-state');
  const binDir = path.join(fixture, 'bin');
  await Promise.all([mkdir(path.join(project, '.lavish'), { recursive: true }), mkdir(stateDir), mkdir(configDir), mkdir(binDir)]);
  lavishFile = path.join(project, '.lavish', 'plan.html');
  revealLog = path.join(fixture, 'xdg-open.log');
  await writeFile(lavishFile, '<!doctype html><title>Plan</title>');
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ sessions: {} }));
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ projects: [{ path: project, name: 'Project' }], archiveRoot: null }));
  const fakeXdgOpen = path.join(binDir, 'xdg-open');
  await writeFile(fakeXdgOpen, `#!/bin/sh\nprintf '%s\\n' "$@" > '${revealLog}'\n`);
  await chmod(fakeXdgOpen, 0o755);
  service = spawn(process.execPath, [path.join(root, 'scripts/local-api.mjs')], {
    cwd: root,
    env: { ...process.env, PATH: binDir, LAVISH_TRACKER_API_PORT: String(port), LAVISH_TRACKER_UI_PORT: '3007', LAVISH_TRACKER_CONFIG_DIR: configDir, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_BIN: '/usr/bin/true' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* Service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Test API did not start.');
});

after(() => service?.kill('SIGTERM'));

test('reveals an artifact folder with xdg-open on Linux', linuxOnly, async () => {
  const library = await (await fetch(`${api}/library`)).json();
  assert.equal(library.fileManager, 'file manager');
  const response = await fetch(`${api}/artifacts/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: lavishFile }) });
  assert.equal(response.status, 202);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const logged = await readFile(revealLog, 'utf8').catch(() => '');
    if (logged) return assert.equal(logged.trim(), path.dirname(lavishFile));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('xdg-open was not called.');
});

test('falls back to pasting a path when Linux has no folder picker', linuxOnly, async () => {
  const response = await fetch(`${api}/projects/choose`, { method: 'POST' });
  const result = await response.json();
  assert.equal(response.status, 400);
  assert.match(result.error, /paste the folder path/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).ok, true);
});
