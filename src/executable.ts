import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

// GUI-launched VS Code often has a smaller PATH than an interactive terminal.
// Resolve files directly: never execute shell startup scripts or shell commands.
export async function resolveCodexExecutable(configured: string, options: {
  pathEnv?: string; home?: string; platform?: NodeJS.Platform; cwd?: string;
} = {}): Promise<string> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const executable = configured.trim() || 'codex';
  const explicit = /[\\/]/.test(executable) || executable.startsWith('~');
  const expanded = executable.replace(/^~(?=[\\/]|$)/, home);
  const directories = (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!explicit && executable === 'codex') {
    directories.push(path.join(home,'.local','bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home,'.npm-global','bin'), path.join(home,'.volta','bin'), path.join(home,'.cargo','bin'));
    if (platform === 'win32' && process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA,'Programs','Codex'));
  }
  const names = platform === 'win32' && !path.extname(executable) ? [`${executable}.exe`, executable] : [executable];
  const candidates = explicit ? [path.resolve(options.cwd ?? process.cwd(),expanded)] : directories.flatMap(directory => names.map(name => path.resolve(directory,name)));
  for (const candidate of new Set(candidates)) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate,platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Try the next installation location. */ }
  }
  throw new Error(`Cannot find the Codex CLI (${executable}). Set "neurologist.codexPath" in VS Code User Settings to the full executable path (for example, ${path.join(home,'.local','bin','codex')}). If Codex is not installed, install it and sign in first. Searched ${candidates.length} executable locations.`);
}
