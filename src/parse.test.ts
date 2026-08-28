import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { parseTokenInput, verifySiteSignature } from './moodle.js';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SIGNATURE = '0123456789abcdef0123456789abcdef';
const PRIVATE = 'ffeeddccbbaa99887766554433221100';

const blob = (...parts: string[]) => Buffer.from(parts.join(':::')).toString('base64');

test('accepts a full moodlemobile:// link', () => {
  const raw = `moodlemobile://token=${blob(SIGNATURE, TOKEN, PRIVATE)}`;
  const parsed = parseTokenInput(raw);

  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.siteSignature, SIGNATURE);
});

test('strips trailing junk picked up by copy and paste', () => {
  for (const suffix of ['>', '"', "'", ' ', ')', ']']) {
    const raw = `moodlemobile://token=${blob(SIGNATURE, TOKEN)}${suffix}`;
    assert.equal(parseTokenInput(raw).token, TOKEN, `suffix ${suffix}`);
  }
});

test('accepts a bare base64 payload with no scheme', () => {
  assert.equal(parseTokenInput(blob(SIGNATURE, TOKEN, PRIVATE)).token, TOKEN);
});

test('accepts a two-field payload, as issued to site admins', () => {
  // launch.php withholds the private token for site admins, so parts.length is 2.
  const parsed = parseTokenInput(blob(SIGNATURE, TOKEN));

  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.privateToken, undefined);
});

test('accepts a bare 32-hex token', () => {
  assert.equal(parseTokenInput(TOKEN).token, TOKEN);
});

test('does NOT base64-decode a bare 32-hex token', () => {
  // A 32-char hex string is also valid base64 (length % 4 === 0). If the base64
  // branch runs first it decodes to 24 bytes of garbage and a good token is
  // silently rejected. This is the ordering trap in parseTokenInput.
  const decoded = Buffer.from(TOKEN, 'base64').toString('utf8');
  assert.notEqual(decoded, TOKEN, 'precondition: hex really is decodable as base64');

  assert.equal(parseTokenInput(TOKEN).token, TOKEN);
});

test('returns the token field, not the site signature', () => {
  // parts[0] is md5(wwwroot + passport) and is also 32 hex, so "find the
  // hex-looking field" would grab the wrong one.
  const parsed = parseTokenInput(blob(SIGNATURE, TOKEN, PRIVATE));

  assert.equal(parsed.token, TOKEN);
  assert.notEqual(parsed.token, SIGNATURE);
});

test('lowercases an uppercase token', () => {
  assert.equal(parseTokenInput(TOKEN.toUpperCase()).token, TOKEN);
});

test('rejects a normal Moodle page address', () => {
  assert.throws(() => parseTokenInput('https://mycourses.aalto.fi/my/'), /does not look like/);
});

test('rejects empty input', () => {
  assert.throws(() => parseTokenInput('   '), /looks empty/);
});

test('verifySiteSignature matches md5(wwwroot + passport)', () => {
  const wwwroot = 'https://mycourses.aalto.fi';
  const passport = '48210773';
  const signature = crypto.createHash('md5').update(`${wwwroot}${passport}`).digest('hex');

  assert.equal(verifySiteSignature(signature, wwwroot, passport), true);
  assert.equal(verifySiteSignature(signature, 'https://example.com', passport), false);
  // An absent signature is not a failure: two-field payloads are legitimate.
  assert.equal(verifySiteSignature(undefined, wwwroot, passport), true);
});
