#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  MoodleConfig,
  checkPermissions,
  configPath,
  loadConfig,
  normalizeSiteInput,
  saveConfig,
  siteRoot,
} from './config.js';
import {
  MoodleApiError,
  MoodleNetworkError,
  PublicConfig,
  REQUIRED_WSFUNCTIONS,
  SiteInfo,
  buildLaunchUrl,
  createClient,
  fetchPublicConfig,
  loginWithPassword,
  parseTokenInput,
  verifySiteSignature,
  verifyToken,
} from './moodle.js';
import {
  bold,
  closePrompts,
  confirm,
  dim,
  fail,
  heading,
  isInteractive,
  ok,
  openBrowser,
  prompt,
  readClipboard,
  rule,
  say,
  warn,
} from './ui.js';

const AALTO = 'https://mycourses.aalto.fi';
const CLIPBOARD_WINDOW_MS = 5 * 60 * 1000;
const CLIPBOARD_POLL_MS = 1000;
const TOKEN_IN_TEXT = /token=([A-Za-z0-9+/=_-]{20,})/;
const BARE_TOKEN = /^[0-9a-f]{32}$/i;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  doctor: boolean;
  help: boolean;
  json: boolean;
  force: boolean;
  clipboard: boolean;
  browser: boolean;
  printClientConfig: boolean;
  site?: string;
  token?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    doctor: false,
    help: false,
    json: false,
    force: false,
    clipboard: true,
    browser: true,
    printClientConfig: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--doctor': options.doctor = true; break;
      case '--help': case '-h': options.help = true; break;
      case '--json': options.json = true; break;
      case '--force': options.force = true; break;
      case '--no-clipboard': options.clipboard = false; break;
      case '--no-browser': options.browser = false; break;
      case '--print-client-config': options.printClientConfig = true; break;
      case '--site': options.site = argv[++i]; break;
      case '--token': options.token = argv[++i]; break;
      default:
        if (arg.startsWith('--site=')) options.site = arg.slice('--site='.length);
        else if (arg.startsWith('--token=')) options.token = arg.slice('--token='.length);
        else {
          fail(`Unknown option: ${arg}`);
          say(`  Run ${bold('npm run setup -- --help')} to see the available options.`);
          process.exit(2);
        }
    }
  }

  return options;
}

function printHelp(): void {
  heading('Moodle for Claude');
  say();
  say('  Connects Claude to your Moodle account so it can read your courses,');
  say('  deadlines and grades. It only ever reads your own data.');
  say();
  say(`  ${bold('Usage')}`);
  say('    npm run setup                 walk through signing in (interactive)');
  say('    npm run doctor                check an existing setup');
  say();
  say(`  ${bold('Options')}`);
  say('    --help                  show this message');
  say('    --doctor                run diagnostics instead of setup');
  say('    --json                  with --doctor: machine-readable output');
  say('    --site <address>        skip the site prompt, e.g. mycourses.aalto.fi');
  say('    --token <token>         set the token directly, no prompts');
  say(`                            ${dim('warning: this puts your token in shell history')}`);
  say('    --force                 reconfigure even if already set up');
  say('    --no-clipboard          do not watch the clipboard; paste instead');
  say('    --no-browser            print the login link, do not open a browser');
  say('    --print-client-config   print the Claude config snippets and exit');
  say();
  say(`  ${bold('Files')}`);
  say(`    ${configPath()}`);
  say(`    ${dim('holds your Moodle address and token, readable only by you')}`);
  say();
}

function preflight(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`This needs Node.js 18 or newer. You have ${process.version}.`);
    say();
    if (process.platform === 'darwin') {
      say('  Fix:  brew install node');
    } else if (process.platform === 'win32') {
      say('  Fix:  download the LTS installer from https://nodejs.org');
    } else {
      say('  Fix:  install Node.js 18+ from your package manager or https://nodejs.org');
    }
    say('  If you use nvm:  nvm install --lts && nvm use --lts');
    say();
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractToken(text: string): string | null {
  const trimmed = text.trim();
  if (BARE_TOKEN.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(TOKEN_IN_TEXT);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------- site prompt

async function promptSite(preset?: string): Promise<string> {
  if (preset) {
    return normalizeSiteInput(preset);
  }

  for (;;) {
    say();
    say('  Which Moodle site do you use?');
    say(`  Press Enter for Aalto University (${bold('mycourses.aalto.fi')}), or type`);
    say('  your own, for example moodle.helsinki.fi');
    say();
    const answer = await prompt('> ', AALTO);

    try {
      return normalizeSiteInput(answer);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

async function probeSite(siteUrl: string): Promise<PublicConfig> {
  say();
  say(`  Checking ${siteUrl} ...`);
  const publicConfig = await fetchPublicConfig(siteUrl);
  ok(`Found "${publicConfig.sitename}"`);
  return publicConfig;
}

function reportSiteBlocked(publicConfig: PublicConfig): boolean {
  if (publicConfig.enablewebservices !== 1) {
    fail(`Web services are turned off on "${publicConfig.sitename}"`);
    say();
    say('    Nothing you can do from here: a Moodle administrator has to');
    say('    enable them. Send them this:');
    say();
    say('      Site administration → Advanced features → Enable web services');
    say();
    say('    Then run  npm run setup  again.');
    say();
    return true;
  }

  if (publicConfig.enablemobilewebservice !== 1) {
    fail(`The mobile app service is turned off on "${publicConfig.sitename}"`);
    say();
    say('    Web services are on, but the mobile service is not. A Moodle');
    say('    administrator needs to enable it:');
    say();
    say('      Site administration → Plugins → Web services → Mobile');
    say('      → Enable web services for mobile devices');
    say();
    say('    Then run  npm run setup  again.');
    say();
    return true;
  }

  return false;
}

// ------------------------------------------------------------- token routes

async function waitForToken(
  launchUrl: string,
  useClipboard: boolean,
  showInstructions: boolean
): Promise<string> {
  // Snapshot first so a stale copy from an earlier attempt is never reused.
  const before = useClipboard ? readClipboard() : null;
  const clipboardWorks = useClipboard && before !== null;

  if (showInstructions) {
    say();
    say('  After you sign in, you will land on a page with a link that says');
    say(`  ${bold('"Click here to launch the app"')}.`);
    say();
    say('    1  Right-click that link');
    say('    2  Choose "Copy Link Address"  (Safari: "Copy Link")');
    say();
  }

  if (clipboardWorks && showInstructions) {
    say('  That is it: I am watching your clipboard and will pick it up');
    say('  automatically. Nothing else on your clipboard is read or stored.');
    say();
  }

  const deadline = Date.now() + CLIPBOARD_WINDOW_MS;

  if (clipboardWorks) {
    // Whichever of the two wins, the other must be cancelled: an abandoned
    // readline question would otherwise eat the next line the user types.
    const controller = new AbortController();

    const typed = prompt(
      '  Waiting for the link ... (or paste it here and press Enter)\n> ',
      undefined,
      controller.signal
    )
      .then((value) => ({ kind: 'typed' as const, value }))
      .catch(() => ({ kind: 'aborted' as const, value: '' }));

    const watched = (async () => {
      while (Date.now() < deadline && !controller.signal.aborted) {
        await sleep(CLIPBOARD_POLL_MS);
        const current = readClipboard();
        if (current && current !== before) {
          const found = extractToken(current);
          if (found) {
            return { kind: 'clipboard' as const, value: found };
          }
        }
      }
      return { kind: 'timeout' as const, value: '' };
    })();

    const pasted = await Promise.race([typed, watched]);

    if (pasted.kind === 'clipboard') {
      controller.abort();
      await typed;
      ok('Picked the link up from your clipboard');
      return pasted.value;
    }

    if (pasted.kind === 'typed' && pasted.value.trim()) {
      return pasted.value;
    }

    controller.abort();
    say();
    rule();
    say('  Still waiting. No problem, take your time.');
  }

  for (;;) {
    say();
    say('  Paste the link here (it looks like moodlemobile://token=NTZhMj... );');
    say('  you can also paste just the 32-character token, or type  r  to');
    say('  reopen the sign-in page.');
    say();
    const answer = await prompt('> ');

    if (answer.trim().toLowerCase() === 'r') {
      say();
      say(`  Reopening: ${launchUrl}`);
      openBrowser(launchUrl);
      continue;
    }

    if (answer.trim()) {
      return answer;
    }
  }
}

async function browserRoute(
  siteUrl: string,
  publicConfig: PublicConfig,
  options: Options
): Promise<{ token: string; passport: string }> {
  const { url, passport } = buildLaunchUrl(publicConfig, siteUrl);

  say();
  say(`  Opening your browser so you can sign in to ${publicConfig.sitename}.`);
  say('  If nothing opens, copy this address into your browser yourself:');
  say();
  say(`    ${url}`);

  if (options.browser) {
    openBrowser(url);
  }

  let first = true;
  for (;;) {
    const raw = await waitForToken(url, options.clipboard, first);
    first = false;
    try {
      const parsed = parseTokenInput(raw);

      if (!verifySiteSignature(parsed.siteSignature, publicConfig.wwwroot, passport)) {
        warn(
          `That link was issued by a different Moodle site than ${new URL(siteUrl).host}. ` +
          'Continuing anyway and letting Moodle decide.'
        );
      }

      return { token: parsed.token, passport };
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      if (/^https?:\/\//i.test(raw.trim())) {
        say('    That is a normal Moodle page address, not the token link. You');
        say('    need the address behind the "Click here to launch the app"');
        say('    link: right-click it and choose "Copy Link Address".');
      }
    }
  }
}

async function securityKeysRoute(siteUrl: string, options: Options): Promise<string> {
  const url = `${siteRoot(siteUrl)}/user/managetoken.php`;

  say();
  say('  Opening your Moodle security keys page.');
  say('  If nothing opens, go here yourself:');
  say();
  say(`    ${url}`);
  say();
  say('  Look for a row whose service is something like "Moodle mobile web');
  say('  service" and copy that token.');
  say();
  warn('Calendar export keys and RSS tokens look identical: also 32 characters.');
  say('    They will not work here. If that is all the page shows, you need');
  say('    the browser sign-in instead.');

  if (options.browser) {
    openBrowser(url);
  }

  for (;;) {
    say();
    const answer = await prompt('  Paste the token here (or type  b  for browser sign-in)\n> ');

    if (answer.trim().toLowerCase() === 'b') {
      return '';
    }

    try {
      return parseTokenInput(answer).token;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

async function passwordRoute(siteUrl: string): Promise<string> {
  say();
  say('  Signing in with your Moodle username and password.');
  say(`  ${dim('This only works if your Moodle has its own password, not single sign-on.')}`);
  say();

  const username = await prompt('  Username: ');
  const password = await prompt('  Password: ');

  return loginWithPassword(siteUrl, username, password);
}

async function resolveToken(
  siteUrl: string,
  publicConfig: PublicConfig,
  options: Options
): Promise<string> {
  const browserLogin =
    publicConfig.typeoflogin === 2 || publicConfig.typeoflogin === 3;

  if (browserLogin) {
    ok('You will sign in through your browser (single sign-on)');
    return (await browserRoute(siteUrl, publicConfig, options)).token;
  }

  const canUsePassword =
    publicConfig.showloginform === 1 &&
    (publicConfig.identityproviders?.length ?? 0) === 0;

  warn('This site does not use browser sign-in, so the token comes from elsewhere.');
  say();
  say('  Options:');
  say();
  say('    1  Copy it from your Moodle profile      (usually works)');
  if (canUsePassword) {
    say('    2  Sign in with your Moodle password    (only if you have a');
    say('                                             Moodle-specific password)');
  }
  say('    3  Try the browser sign-in anyway');
  say();

  const choice = await prompt('  Which? [1] ', '1');

  if (choice === '2' && canUsePassword) {
    return passwordRoute(siteUrl);
  }

  if (choice === '3') {
    return (await browserRoute(siteUrl, publicConfig, options)).token;
  }

  const token = await securityKeysRoute(siteUrl, options);
  // Empty means the user asked for the browser escape hatch instead. launch.php
  // can still work here (oauth2, or an already-live session), so it is worth a try.
  if (!token) {
    return (await browserRoute(siteUrl, publicConfig, options)).token;
  }
  return token;
}

// A rejected token must not end the session. Calendar export keys and RSS
// tokens are byte-identical to a real token (both are md5 output), so the only
// way to tell them apart is to ask Moodle — which means the rejection lands
// here, after the user has already pasted something, and they need a way back.
async function resolveTokenVerified(
  siteUrl: string,
  publicConfig: PublicConfig,
  options: Options
): Promise<{ token: string; siteInfo: SiteInfo }> {
  for (;;) {
    const token = await resolveToken(siteUrl, publicConfig, options);

    say();
    say('  Checking the connection with Moodle ...');

    try {
      const siteInfo = await verifyToken(siteUrl, token);
      return { token, siteInfo };
    } catch (error) {
      if (!(error instanceof MoodleApiError) || !error.isAuthFailure) {
        throw error;
      }

      say();
      fail(`Moodle rejected that key (${error.errorcode}).`);

      if (/^[0-9a-f]{32}$/i.test(token)) {
        say();
        say('    It is the right length, but Moodle says it is not a web service');
        say('    token. Calendar export keys and RSS tokens look exactly the');
        say('    same, 32 characters, and are the usual mix-up.');
      }

      if (!isInteractive()) {
        throw error;
      }

      say();
      const again = await confirm('  Try again?', true);
      if (!again) {
        say();
        say('  Nothing was saved.');
        process.exit(1);
      }
    }
  }
}

// ------------------------------------------------------- verify, save, report

async function writeAndVerify(
  siteUrl: string,
  token: string,
  publicConfig: PublicConfig,
  verified?: SiteInfo
): Promise<{ config: MoodleConfig; siteInfo: SiteInfo; path: string }> {
  let siteInfo = verified;

  if (!siteInfo) {
    say();
    say('  Checking the connection with Moodle ...');
    siteInfo = await verifyToken(siteUrl, token);
  }

  ok(`Signed in as ${bold(siteInfo.username)} (${siteInfo.fullname})`);

  const available = new Set((siteInfo.functions ?? []).map((fn) => fn.name));
  const missing = REQUIRED_WSFUNCTIONS.filter((fn) => !available.has(fn));

  if (available.size === 0) {
    warn('The site did not list its available functions, so I cannot check them.');
  } else if (missing.length === 0) {
    ok(`All ${REQUIRED_WSFUNCTIONS.length} functions this server needs are available`);
  } else {
    warn(`${missing.length} function(s) this server needs are not available:`);
    for (const fn of missing) {
      say(`      ${fn}`);
    }
    say('    The tools that use them will not work. Everything else will.');
  }

  const config: MoodleConfig = {
    version: 1,
    siteUrl,
    token,
    siteName: publicConfig.sitename || siteInfo.sitename,
    username: siteInfo.username,
    createdAt: new Date().toISOString(),
  };

  const savedTo = saveConfig(config);

  say();
  if (process.platform === 'win32') {
    say(`  Saved to ${savedTo}`);
  } else {
    say(`  Saved to ${savedTo}  ${dim('(readable only by you)')}`);
  }

  return { config, siteInfo, path: savedTo };
}

// The payoff, deliberately before the Claude-config step: proves it works with
// the user's own data. Must never block the flow if a fetch is slow or partial.
// Aalto full names look like "CS-C3250 - Data Science Project, Contact teaching,
// 31.8.2026-26.11.2026". The trailing delivery type and dates are noise here,
// and the shortname is an opaque GUID, so use the first segment of fullname.
function courseLabel(course: { fullname?: string; shortname?: string }): string {
  const source = (course.fullname || course.shortname || 'Untitled course').trim();
  const label = source.split(',')[0].trim();
  return label.length > 64 ? `${label.slice(0, 63)}…` : label;
}

async function showFirstResults(config: MoodleConfig, userId: number): Promise<void> {
  try {
    const client = createClient(config.siteUrl, config.token);

    const coursesResponse = await client.get('', {
      params: { wsfunction: 'core_enrol_get_users_courses', userid: userId },
    });

    const courses = (coursesResponse.data || []) as {
      id: number;
      shortname: string;
      fullname: string;
      enddate?: number;
    }[];

    if (courses.length === 0) {
      say();
      say('  You are not enrolled in any courses right now.');
      return;
    }

    const now = Date.now() / 1000;
    // Students accumulate years of finished courses, so listing all of them is
    // noise. Show the ones that have not ended yet.
    const current = courses.filter(
      (course) => !course.enddate || course.enddate > now
    );
    const shown = current.length > 0 ? current : courses;

    say();
    if (current.length > 0 && current.length < courses.length) {
      say(`  ${bold(`Found ${courses.length} courses, ${current.length} still running:`)}`);
    } else {
      say(`  ${bold(`Found ${courses.length} course${courses.length === 1 ? '' : 's'}:`)}`);
    }

    for (const course of shown.slice(0, 8)) {
      say(`    ${courseLabel(course)}`);
    }
    if (shown.length > 8) {
      say(`    ${dim(`... and ${shown.length - 8} more`)}`);
    }

    const assignmentsResponse = await client.get('', {
      params: {
        wsfunction: 'mod_assign_get_assignments',
        courseids: shown.map((course) => course.id),
      },
    });

    const assignments = ((assignmentsResponse.data?.courses || []) as any[]).flatMap(
      (course: any) =>
        (course.assignments || []).map((assignment: any) => ({
          name: assignment.name as string,
          course: courseLabel(course),
          duedate: assignment.duedate as number,
        }))
    );

    const upcoming = assignments
      .filter((item) => item.duedate && item.duedate > now)
      .sort((a, b) => a.duedate - b.duedate);

    say();
    if (upcoming.length > 0) {
      const next = upcoming[0];
      const due = new Date(next.duedate * 1000);
      const days = Math.round((next.duedate - now) / 86400);
      const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;

      say(`  ${bold('Your next deadline:')}`);
      say(`    ${next.name} — ${next.course}`);
      say(`    due ${due.toLocaleString()} (${when})`);
    } else if (assignments.length > 0) {
      say(
        `  ${bold(`Read ${assignments.length} assignments`)} across your courses. None of them`
      );
      say('  has a deadline in the future right now, so nothing is due.');
    } else {
      say('  No assignments found in these courses yet.');
    }

    say();
    say(`  ${dim('That came from your Moodle account just now.')}`);
  } catch (error) {
    // The token is already verified and saved by this point, so a failure here
    // is cosmetic and must not look like a setup failure.
    say();
    say(`  ${dim('(Could not load your courses for a preview, but the connection works.)')}`);
  }
}

function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function printClientConfig(): void {
  const serverPath = path.join(repoRoot, 'build', 'index.js');
  // Absolute node path, not "node": Claude Desktop launches from the GUI with a
  // minimal PATH that excludes nvm and Homebrew shims.
  const nodePath = process.execPath;

  rule();
  say(`  ${bold('Last step: tell Claude about it.')}`);
  say();
  say(`  ${bold('Claude Desktop')} — add this to`);
  say(`  ${claudeDesktopConfigPath()}`);
  say();
  say('  {');
  say('    "mcpServers": {');
  say('      "moodle": {');
  say(`        "command": "${nodePath}",`);
  say(`        "args": ["${serverPath}"]`);
  say('      }');
  say('    }');
  say('  }');
  say();
  say('  There is no token in there: it lives in your settings file, which only');
  say('  you can read. If you already have other servers listed, add the');
  say('  "moodle" block alongside them, do not replace the whole file.');
  say();
  say('  Then quit Claude Desktop completely (Cmd+Q, not just the window) and');
  say('  open it again.');
  say();
  say(`  ${bold('Claude Code')} — run`);
  say();
  say(`    claude mcp add moodle --scope user -- ${nodePath} ${serverPath}`);
  say();
}

function printNextSteps(): void {
  printClientConfig();
  say('  Then try asking:');
  say(`    ${bold('"What Moodle assignments do I have due this week?"')}`);
  say();
  say('  If something goes wrong later, run:  npm run doctor');
  say();
}

// ------------------------------------------------------------------- setup

async function runSetup(options: Options): Promise<void> {
  heading('Moodle for Claude — setup');
  say();
  say('  This connects Claude to your Moodle account so it can see your');
  say('  courses, deadlines and grades. It only ever reads your own data.');
  say('  Takes about a minute. You will need to log in to Moodle once.');

  const existing = loadConfig();
  if (existing.ok && !options.force && !options.token) {
    say();
    say(`  You are already set up: ${bold(existing.config.username ?? 'unknown user')} on ${existing.config.siteName ?? existing.config.siteUrl}.`);
    if (!isInteractive()) {
      say('  Run with --force to replace it.');
      return;
    }
    const replace = await confirm('  Re-run setup and replace it?', false);
    if (!replace) {
      say();
      say('  Nothing changed.');
      return;
    }
  }

  if (!isInteractive() && !(options.site && options.token)) {
    fail('This needs a terminal it can ask questions in.');
    say();
    say('  Either run it directly in a terminal:');
    say(`      cd ${repoRoot} && npm run setup`);
    say('  or pass everything up front:');
    say('      npm run setup -- --site mycourses.aalto.fi --token YOUR_TOKEN');
    say();
    process.exit(2);
  }

  const siteUrl = await promptSite(options.site);
  const publicConfig = await probeSite(siteUrl);

  if (reportSiteBlocked(publicConfig)) {
    process.exit(1);
  }

  ok('This site allows app connections');

  if (publicConfig.maintenanceenabled) {
    warn('This site is in maintenance mode, so signing in may fail right now.');
  }

  let token: string;
  let verified: SiteInfo | undefined;

  if (options.token) {
    token = parseTokenInput(options.token).token;
  } else {
    const resolved = await resolveTokenVerified(siteUrl, publicConfig, options);
    token = resolved.token;
    verified = resolved.siteInfo;
  }

  const { config, siteInfo } = await writeAndVerify(
    siteUrl,
    token,
    publicConfig,
    verified
  );

  await showFirstResults(config, siteInfo.userid);

  say();
  printNextSteps();
}

// ------------------------------------------------------------------- doctor

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

async function runDoctor(options: Options): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) =>
    checks.push({ name, status, detail });

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 18 ? 'ok' : 'fail', process.version);

  // 2. Build freshness
  const built = path.join(repoRoot, 'build', 'index.js');
  const source = path.join(repoRoot, 'src', 'index.ts');
  if (!fs.existsSync(built)) {
    add('Server built', 'fail', 'build/index.js is missing — run npm run build');
  } else if (fs.existsSync(source) && fs.statSync(source).mtimeMs > fs.statSync(built).mtimeMs) {
    add('Server built', 'warn', 'build is older than the source — run npm run build');
  } else {
    add('Server built', 'ok', `build/index.js (${fs.statSync(built).mtime.toLocaleString()})`);
  }

  // 3. Config
  const result = loadConfig();
  if (!result.ok) {
    const detail = result.reason === 'missing'
      ? `no settings file at ${result.path} — run npm run setup`
      : `${result.reason}: ${result.detail ?? ''} (${result.path})`;
    add('Settings file', 'fail', detail);
    report(checks, options);
    process.exit(1);
  }

  add('Settings file', 'ok', result.path);

  if (result.source !== 'file') {
    add(
      'Environment',
      'warn',
      'MOODLE_API_URL/MOODLE_API_TOKEN are set in your environment and override the settings file'
    );
  }

  // 4. Permissions
  const perms = checkPermissions();
  if (!perms) {
    add('Permissions', 'warn', 'could not read the settings file mode');
  } else if (process.platform === 'win32') {
    add('Permissions', 'ok', 'not checked on Windows');
  } else if (perms.tooOpen) {
    add('Permissions', 'warn', `${perms.mode.toString(8)} — others can read it; run chmod 600 ${result.path}`);
  } else {
    add('Permissions', 'ok', `${perms.mode.toString(8)} (only you can read it)`);
  }

  const { siteUrl, token } = result.config;
  add('Site address', 'ok', siteRoot(siteUrl));

  // 5. Site reachable
  let publicConfig: PublicConfig | undefined;
  try {
    publicConfig = await fetchPublicConfig(siteUrl);
    const webServicesOn =
      publicConfig.enablewebservices === 1 && publicConfig.enablemobilewebservice === 1;
    add(
      'Site reachable',
      webServicesOn ? 'ok' : 'fail',
      `"${publicConfig.sitename}", app connections ${webServicesOn ? 'enabled' : 'DISABLED on the site'}`
    );
  } catch (error) {
    add('Site reachable', 'fail', error instanceof Error ? error.message : String(error));
  }

  // 6 + 7. Token and functions
  try {
    const siteInfo = await verifyToken(siteUrl, token);
    add('Token works', 'ok', `${siteInfo.username} (id ${siteInfo.userid})${siteInfo.release ? `, Moodle ${siteInfo.release}` : ''}`);

    const available = new Set((siteInfo.functions ?? []).map((fn) => fn.name));
    const missing = REQUIRED_WSFUNCTIONS.filter((fn) => !available.has(fn));
    if (available.size === 0) {
      add('Functions', 'warn', 'the site did not list its functions');
    } else if (missing.length === 0) {
      add('Functions', 'ok', `${REQUIRED_WSFUNCTIONS.length} of ${REQUIRED_WSFUNCTIONS.length} available`);
    } else {
      add('Functions', 'warn', `missing: ${missing.join(', ')}`);
    }
  } catch (error) {
    if (error instanceof MoodleApiError) {
      add('Token works', 'fail', `${error.errorcode} — ${error.moodleMessage}`);
    } else if (error instanceof MoodleNetworkError) {
      add('Token works', 'fail', error.message);
    } else {
      add('Token works', 'fail', error instanceof Error ? error.message : String(error));
    }
  }

  // 8. Client registration
  const serverPath = path.join(repoRoot, 'build', 'index.js');
  const desktopPath = claudeDesktopConfigPath();
  if (!fs.existsSync(desktopPath)) {
    add('Claude Desktop', 'warn', 'no config file found — see npm run setup -- --print-client-config');
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(desktopPath, 'utf8'));
      const entries: [string, any][] = Object.entries(parsed.mcpServers ?? {});
      const match = entries.find(([, value]) =>
        Array.isArray(value?.args) && value.args.some((arg: string) => arg === serverPath)
      );

      if (!match) {
        const other = entries.find(([name]) => name.toLowerCase().includes('moodle'));
        if (other) {
          add('Claude Desktop', 'warn', `"${other[0]}" points at a different copy: ${other[1]?.args?.[0] ?? 'unknown'}`);
        } else {
          add('Claude Desktop', 'warn', 'this server is not registered — see --print-client-config');
        }
      } else if (match[1].command && !fs.existsSync(match[1].command)) {
        add('Claude Desktop', 'fail', `"${match[0]}" registered, but its node path no longer exists: ${match[1].command}`);
      } else {
        add('Claude Desktop', 'ok', `"${match[0]}" registered, node path valid`);
      }
    } catch (error) {
      add('Claude Desktop', 'fail', `config file is not valid JSON (${desktopPath})`);
    }
  }

  const claudeCli = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 5000 });
  if (claudeCli.error || claudeCli.status !== 0) {
    add('Claude Code', 'warn', 'claude CLI not available, skipped');
  } else if (claudeCli.stdout.includes(serverPath)) {
    add('Claude Code', 'ok', 'registered');
  } else {
    add('Claude Code', 'warn', `not registered — claude mcp add moodle --scope user -- ${process.execPath} ${serverPath}`);
  }

  report(checks, options);
  if (checks.some((check) => check.status === 'fail')) {
    process.exit(1);
  }
}

function report(checks: Check[], options: Options): void {
  if (options.json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  heading('Moodle for Claude — checkup');
  const width = Math.max(...checks.map((check) => check.name.length));

  for (const check of checks) {
    const label = check.name.padEnd(width);
    if (check.status === 'ok') ok(`${label}  ${check.detail}`);
    else if (check.status === 'warn') warn(`${label}  ${check.detail}`);
    else fail(`${label}  ${check.detail}`);
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;

  say();
  if (failures > 0) {
    say(`  ${failures} problem${failures === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`);
  } else if (warnings > 0) {
    say(`  ${warnings} warning${warnings === 1 ? '' : 's'}. Everything important is working.`);
  } else {
    say('  Everything checks out.');
  }
  say();
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  preflight();

  if (options.printClientConfig) {
    printClientConfig();
    return;
  }

  if (options.doctor) {
    await runDoctor(options);
    return;
  }

  await runSetup(options);
}

main()
  .catch((error) => {
    say();
    if (error instanceof MoodleApiError && error.isAuthFailure) {
      fail(`Moodle rejected that token (${error.errorcode}). Nothing was saved.`);
      say();
      say('  If you pasted it by hand, check you took the middle of the three');
      say('  :::-separated fields. Otherwise run setup again and use the');
      say('  browser sign-in.');
    } else if (error instanceof MoodleApiError) {
      fail(error.userMessage);
    } else if (error instanceof MoodleNetworkError) {
      fail(error.message);
    } else {
      fail(error instanceof Error ? error.message : String(error));
    }
    say();
    process.exitCode = 1;
  })
  .finally(() => {
    closePrompts();
  });
