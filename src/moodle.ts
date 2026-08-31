import crypto from 'node:crypto';
import axios, { AxiosInstance } from 'axios';
import { restEndpoint, siteRoot } from './config.js';

const REQUEST_TIMEOUT_MS = 20000;

// Moodle answers with HTTP 200 and an errorcode body, so axios never treats
// an auth failure as an error on its own.
export class MoodleApiError extends Error {
  constructor(
    readonly errorcode: string,
    readonly moodleMessage: string,
    readonly exception?: string
  ) {
    super(`${errorcode}: ${moodleMessage}`);
    this.name = 'MoodleApiError';
  }

  get isAuthFailure(): boolean {
    return ['invalidtoken', 'accessexception', 'tokenexpired', 'invalidrecord'].includes(
      this.errorcode
    );
  }

  get isPermission(): boolean {
    return [
      'nopermissions',
      'requireloginerror',
      'required_capability_exception',
    ].includes(this.errorcode);
  }

  get isSiteConfig(): boolean {
    return ['servicenotavailable', 'enablewsdescription'].includes(this.errorcode);
  }

  get userMessage(): string {
    switch (this.errorcode) {
      case 'invalidtoken':
      case 'tokenexpired':
      case 'invalidrecord':
        return (
          'Your Moodle token is no longer valid. Moodle revokes tokens when you change ' +
          'your password or when the site expires them.\n\n' +
          'Fix: run `npm run setup` again. No need to restart Claude.'
        );
      case 'accessexception':
        return (
          'Moodle refused the token (accessexception). Usually this means web services ' +
          'were turned off on the site, or the token is restricted to a different network.\n\n' +
          'Fix: run `npm run doctor` to see which one it is.'
        );
      case 'nopermissions':
      case 'requireloginerror':
      case 'required_capability_exception':
        return (
          "Your account is not allowed to read that. This server only ever reads your own " +
          'data, so this normally means the course hides the item from students.'
        );
      case 'servicenotavailable':
      case 'enablewsdescription':
        return (
          'The Moodle mobile web service is not enabled on this site, so no token can work ' +
          'here.\n\nFix: ask your Moodle administrator to enable it, then run `npm run setup`.'
        );
      default:
        return `Moodle returned an error (${this.errorcode}): ${this.moodleMessage}\n\nRun \`npm run doctor\` for a full checkup.`;
    }
  }
}

export class MoodleNetworkError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'MoodleNetworkError';
  }
}

export interface PublicConfig {
  wwwroot: string;
  sitename: string;
  enablewebservices: number;
  enablemobilewebservice: number;
  typeoflogin: number;
  launchurl?: string;
  showloginform?: number;
  maintenanceenabled?: number;
  identityproviders?: { name: string; url: string }[];
}

export interface SiteInfo {
  username: string;
  fullname: string;
  userid: number;
  sitename: string;
  release?: string;
  functions?: { name: string; version: string }[];
}

export const REQUIRED_WSFUNCTIONS = [
  'core_webservice_get_site_info',
  'core_enrol_get_users_courses',
  'mod_assign_get_assignments',
  'mod_assign_get_submission_status',
  'mod_quiz_get_quizzes_by_courses',
  'mod_quiz_get_user_best_grade',
  'core_course_get_contents',
  'mod_forum_get_forums_by_courses',
  'mod_forum_get_forum_discussions',
  'core_calendar_get_calendar_events',
];

export function createClient(siteUrl: string, token: string): AxiosInstance {
  const instance = axios.create({
    baseURL: restEndpoint(siteUrl),
    timeout: REQUEST_TIMEOUT_MS,
    params: {
      wstoken: token,
      moodlewsrestformat: 'json',
    },
  });

  instance.interceptors.response.use((response) => {
    const data = response.data;
    // Only a top-level errorcode is an error: normal payloads such as
    // { courses: [...], warnings: [...] } must pass straight through.
    if (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      typeof data.errorcode === 'string'
    ) {
      throw new MoodleApiError(data.errorcode, data.message ?? '', data.exception);
    }
    return response;
  });

  return instance;
}

export function describeNetworkError(error: unknown, host: string): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const code = error.code;

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not find ${host}. The site address may be misspelled, or you may be offline.\n\nRun \`npm run doctor\` to check.`;
  }

  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ECONNRESET' ||
    code === 'EPROTO'
  ) {
    return (
      `Could not reach ${host}. Check the spelling of the address, your internet ` +
      'connection, and if your Moodle needs a university VPN, connect to it first.'
    );
  }

  if (code && code.startsWith('CERT_')) {
    return `The security certificate for ${host} could not be verified (${code}). If you are on a network that intercepts traffic, that is the likely cause.`;
  }

  const status = error.response?.status;
  if (status) {
    return `${host} responded with HTTP ${status}. If that address is not actually a Moodle site, run \`npm run setup\` and enter it again.`;
  }

  return `Could not reach ${host}: ${error.message}`;
}

export async function fetchPublicConfig(siteUrl: string): Promise<PublicConfig> {
  const root = siteRoot(siteUrl);
  const url = `${root}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`;
  const host = new URL(root).host;

  let response;
  try {
    response = await axios.post(
      url,
      [{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }],
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    throw new MoodleNetworkError(
      describeNetworkError(error, host),
      axios.isAxiosError(error) ? error.code : undefined
    );
  }

  const entry = Array.isArray(response.data) ? response.data[0] : undefined;

  if (!entry || (!entry.data && !entry.error)) {
    throw new MoodleNetworkError(
      `${host} responded, but it does not look like a Moodle site. Use the address you see when you log in to Moodle, for example mycourses.aalto.fi`
    );
  }

  if (entry.error) {
    const message =
      typeof entry.exception?.message === 'string'
        ? entry.exception.message
        : 'the site refused the request';
    throw new MoodleNetworkError(`${host} refused the request: ${message}`);
  }

  return entry.data as PublicConfig;
}

export async function verifyToken(siteUrl: string, token: string): Promise<SiteInfo> {
  const client = createClient(siteUrl, token);
  const response = await client.get('', {
    params: { wsfunction: 'core_webservice_get_site_info' },
  });

  if (!response.data?.userid) {
    throw new MoodleApiError(
      'invalidtoken',
      'the site did not return a user for this token'
    );
  }

  return response.data as SiteInfo;
}

export async function loginWithPassword(
  siteUrl: string,
  username: string,
  password: string
): Promise<string> {
  const url = `${siteRoot(siteUrl)}/login/token.php`;

  const response = await axios.post(url, null, {
    timeout: REQUEST_TIMEOUT_MS,
    params: { username, password, service: 'moodle_mobile_app' },
  });

  if (response.data?.token) {
    return response.data.token as string;
  }

  throw new MoodleApiError(
    response.data?.errorcode ?? 'invalidlogin',
    response.data?.error ?? 'the site did not return a token for those credentials'
  );
}

export function buildLaunchUrl(
  publicConfig: PublicConfig,
  siteUrl: string
): { url: string; passport: string } {
  const passport = String(crypto.randomInt(10_000_000, 100_000_000));
  // launchurl is authoritative: it is correct even when the site renamed its
  // admin directory or lives in a subdirectory.
  const base =
    publicConfig.launchurl || `${siteRoot(siteUrl)}/admin/tool/mobile/launch.php`;

  const url =
    `${base}?service=moodle_mobile_app&passport=${passport}` +
    `&urlscheme=moodlemcp&confirmed=1`;

  return { url, passport };
}

export interface ParsedToken {
  token: string;
  siteSignature?: string;
  privateToken?: string;
}

export function parseTokenInput(raw: string): ParsedToken {
  let value = raw.trim().replace(/^['"]|['"]$/g, '');

  const marker = value.indexOf('token=');
  if (marker !== -1) {
    value = value.slice(marker + 'token='.length);
  }

  value = value.replace(/[\s'"<>)\]]+$/g, '');

  if (!value) {
    throw new Error("that looks empty. Paste the whole link, or the 32-character token.");
  }

  // Must precede the base64 branch: a bare 32-hex token is also valid base64
  // (length % 4 === 0) and would decode into 24 bytes of garbage.
  if (/^[0-9a-f]{32}$/i.test(value)) {
    return { token: value.toLowerCase() };
  }

  let b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);

  let decoded = '';
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    decoded = '';
  }

  const parts = decoded.split(':::');
  // parts[0] is md5(wwwroot + passport) and is also 32 hex, so the token must
  // be taken by index rather than by "find the hex-looking field".
  if (parts.length >= 2 && /^[0-9a-f]{32}$/i.test(parts[1])) {
    return {
      siteSignature: parts[0],
      token: parts[1].toLowerCase(),
      privateToken: parts[2],
    };
  }

  throw new Error("that does not look like a Moodle token or a moodlemobile:// link.");
}

export function verifySiteSignature(
  signature: string | undefined,
  wwwroot: string,
  passport: string
): boolean {
  if (!signature) {
    return true;
  }
  const expected = crypto
    .createHash('md5')
    .update(`${wwwroot}${passport}`)
    .digest('hex');
  return expected === signature.toLowerCase();
}
