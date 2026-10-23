import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const HOMEBREW_LAVISH_BIN = '/opt/homebrew/bin/lavish-axi';

export function commandPath(name) {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

export function resolveLavishBin({ env = process.env, lookup = commandPath } = {}) {
  return env.LAVISH_AXI_BIN || lookup('lavish-axi') || HOMEBREW_LAVISH_BIN;
}

export function fileManagerName(platform = process.platform) {
  return platform === 'darwin' ? 'Finder' : 'file manager';
}

export function openCommand(target, platform = process.platform) {
  return platform === 'darwin' ? ['/usr/bin/open', [target]] : ['xdg-open', [target]];
}

export function revealCommand(file, platform = process.platform) {
  return platform === 'darwin' ? ['/usr/bin/open', ['-R', file]] : ['xdg-open', [path.dirname(file)]];
}

export function folderPickerCommand(prompt, { platform = process.platform, lookup = commandPath } = {}) {
  if (platform === 'darwin') return ['/usr/bin/osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]];
  if (lookup('zenity')) return ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]];
  if (lookup('kdialog')) return ['kdialog', ['--getexistingdirectory', os.homedir(), '--title', prompt]];
  return null;
}

export function folderPickerError(code, stderr, platform = process.platform) {
  const message = stderr.trim();
  const cancelled = platform === 'darwin' ? message.includes('User canceled') : code === 0 || code === 1 || !message;
  return cancelled ? 'Folder selection cancelled.' : message;
}

export function launchDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
