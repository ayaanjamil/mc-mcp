import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MoodleConfig {
  version: 1;
  siteUrl: string;
  token: string;
  siteName?: string;
  username?: string;
  createdAt?: string;
}

export type ConfigSource = 'env' | 'file' | 'env+file';

export type ConfigResult =
  | { ok: true; config: MoodleConfig; source: ConfigSource; path: string }
  | {
    ok: false;
    reason: 'missing' | 'malformed' | 'incomplete';
    path: string;
    detail?: string;
  };

export function configDir(): string {
  const override = process.env.MOODLE_MCP_CONFIG_DIR;
  if (override) {
    return override;
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, 'moodle-mcp');
  }

  const home = os.homedir();
  if (!home) {
    throw new Error(
      'Could not determine your home directory, so there is nowhere to store the Moodle settings. ' +
      'Set MOODLE_MCP_CONFIG_DIR to a directory you can write to.'
    );
  }

  return path.join(home, '.config', 'moodle-mcp');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

// Appends the REST endpoint only when it is not already there, so the old
// full-endpoint MOODLE_API_URL values keep working untouched.
export function restEndpoint(siteUrl: string): string {
  const trimmed = siteUrl.replace(/\/+$/, '');
  return /\/webservice\/rest\/server\.php$/.test(trimmed)
    ? trimmed
    : `${trimmed}/webservice/rest/server.php`;
}

// The inverse of restEndpoint: back-compat MOODLE_API_URL values hold the full
// REST endpoint, but the public-config probe, the launch URL and the security
// keys page all hang off the site root.
export function siteRoot(siteUrl: string): string {
  return siteUrl
    .replace(/\/+$/, '')
    .replace(/\/webservice\/rest\/server\.php$/, '');
}

export function normalizeSiteInput(raw: string): string {
  let value = raw.trim().replace(/^['"]|['"]$/g, '').trim();

  if (!value) {
    throw new Error('Please enter a Moodle site address.');
  }

  value = value.split(/[?#]/)[0];

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${raw.trim()}" is not a valid web address.`);
  }

  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !isLocal) {
    throw new Error(
      `Refusing to use http:// for ${url.hostname}. Your Moodle token would travel unencrypted. Use https:// instead.`
    );
  }

  let pathname = url.pathname
    .replace(/\/login\/index\.php$/, '')
    .replace(/\/my\/?$/, '')
    .replace(/\/+$/, '');

  return `${url.protocol}//${url.host}${pathname}`;
}

// Never throws for an absent or damaged file: the server needs to start and
// explain itself rather than die before the transport connects.
export function loadConfig(): ConfigResult {
  let filePath: string;
  try {
    filePath = configPath();
  } catch (error) {
    return {
      ok: false,
      reason: 'missing',
      path: '(unknown)',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let fromFile: Partial<MoodleConfig> = {};
  let fileExisted = false;

  if (fs.existsSync(filePath)) {
    fileExisted = true;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return {
        ok: false,
        reason: 'malformed',
        path: filePath,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          reason: 'malformed',
          path: filePath,
          detail: 'the file does not contain a JSON object',
        };
      }
      fromFile = parsed as Partial<MoodleConfig>;
    } catch (error) {
      return {
        ok: false,
        reason: 'malformed',
        path: filePath,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const envUrl = process.env.MOODLE_API_URL?.trim();
  const envToken = process.env.MOODLE_API_TOKEN?.trim();

  const siteUrl = envUrl || fromFile.siteUrl?.trim() || '';
  const token = envToken || fromFile.token?.trim() || '';

  if (!siteUrl || !token) {
    if (!fileExisted && !envUrl && !envToken) {
      return { ok: false, reason: 'missing', path: filePath };
    }

    const missing = [!siteUrl && 'site address', !token && 'token']
      .filter(Boolean)
      .join(' and ');

    return {
      ok: false,
      reason: 'incomplete',
      path: filePath,
      detail: `no ${missing}`,
    };
  }

  const usedEnv = Boolean(envUrl || envToken);
  const source: ConfigSource = usedEnv
    ? (fileExisted ? 'env+file' : 'env')
    : 'file';

  return {
    ok: true,
    source,
    path: filePath,
    config: {
      version: 1,
      siteUrl,
      token,
      siteName: fromFile.siteName,
      username: fromFile.username,
      createdAt: fromFile.createdAt,
    },
  };
}

export function saveConfig(config: MoodleConfig): string {
  const dir = configDir();
  const target = path.join(dir, 'config.json');
  const tmp = `${target}.tmp`;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask and ignored for an existing directory.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // No-op on Windows.
  }

  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // No-op on Windows.
  }
  fs.renameSync(tmp, target);

  return target;
}

export function checkPermissions(): { mode: number; tooOpen: boolean } | null {
  const target = configPath();
  if (!fs.existsSync(target)) {
    return null;
  }

  const mode = fs.statSync(target).mode & 0o777;

  // chmod is not meaningful on NTFS, so never claim the file is locked down there.
  if (process.platform === 'win32') {
    return { mode, tooOpen: false };
  }

  return { mode, tooOpen: (mode & 0o077) !== 0 };
}
