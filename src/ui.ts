import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const useColor = Boolean(output.isTTY) && !process.env.NO_COLOR;

const paint = (code: string) => (text: string) =>
  useColor ? `[${code}m${text}[0m` : text;

export const bold = paint('1');
export const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');

export function say(text = ''): void {
  console.log(text);
}

export function heading(text: string): void {
  say();
  say(`  ${bold(text)}`);
  say(`  ${dim('─'.repeat(57))}`);
}

export function rule(): void {
  say(`  ${dim('─'.repeat(57))}`);
}

export function ok(text: string): void {
  say(`  ${green('✔')} ${text}`);
}

export function warn(text: string): void {
  say(`  ${yellow('⚠')} ${text}`);
}

export function fail(text: string): void {
  say(`  ${red('✘')} ${text}`);
}

export function isInteractive(): boolean {
  return Boolean(input.isTTY);
}

let rl: readline.Interface | undefined;

function ensureReadline(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input, output });
  }
  return rl;
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}

// signal matters when a prompt races something else (the clipboard watcher):
// without aborting the loser, its question stays queued in readline and
// swallows the user's next line.
export async function prompt(
  question: string,
  fallback?: string,
  signal?: AbortSignal
): Promise<string> {
  const answer = (await ensureReadline().question(question, { signal })).trim();
  return answer || fallback || '';
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ensureReadline().question(`${question} ${suffix} `))
    .trim()
    .toLowerCase();

  if (!answer) {
    return defaultYes;
  }
  return answer.startsWith('y');
}

// Never awaited: a browser that refuses to open must not stall setup, and the
// URL is always printed as well so WSL, SSH and headless boxes still work.
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return;
    }

    if (process.platform === 'win32') {
      // `start` reads the first quoted argument as a window title, hence the
      // empty "" — and & must be caret-escaped or the query string truncates.
      spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
      return;
    }

    for (const opener of ['xdg-open', 'gio', 'sensible-browser', 'x-www-browser']) {
      try {
        const args = opener === 'gio' ? ['open', url] : [url];
        spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
        return;
      } catch {
        continue;
      }
    }
  } catch {
    // Caller already printed the URL.
  }
}

function runCapture(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2000 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout;
}

// Returns null when no clipboard tool exists, so the caller can skip the
// clipboard offer entirely rather than lecturing the user about xclip.
export function readClipboard(): string | null {
  if (process.platform === 'darwin') {
    return runCapture('pbpaste', []);
  }

  if (process.platform === 'win32') {
    return runCapture('powershell', ['-NoProfile', '-Command', 'Get-Clipboard']);
  }

  return runCapture('wl-paste', ['--no-newline']) ?? runCapture('xclip', ['-o', '-selection', 'clipboard']);
}
