import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  loadConfig,
  normalizeSiteInput,
  restEndpoint,
  saveConfig,
  siteRoot,
} from './config.js';

const AALTO = 'https://mycourses.aalto.fi';
const ENDPOINT = `${AALTO}/webservice/rest/server.php`;

test('restEndpoint appends the REST path to a bare site URL', () => {
  assert.equal(restEndpoint(AALTO), ENDPOINT);
  assert.equal(restEndpoint(`${AALTO}/`), ENDPOINT);
});

test('restEndpoint is idempotent on an existing endpoint', () => {
  // Old .env values and existing Claude Desktop env blocks hold the full
  // endpoint. Double-appending would break every request.
  assert.equal(restEndpoint(ENDPOINT), ENDPOINT);
  assert.equal(restEndpoint(restEndpoint(AALTO)), ENDPOINT);
});

test('siteRoot strips the REST endpoint back off', () => {
  // Back-compat MOODLE_API_URL values hold the full endpoint, but the public
  // config probe, launch URL and security keys page hang off the site root.
  assert.equal(siteRoot(ENDPOINT), AALTO);
  assert.equal(siteRoot(AALTO), AALTO);
  assert.equal(siteRoot(`${AALTO}/`), AALTO);
  assert.equal(siteRoot(restEndpoint(AALTO)), AALTO);
});

test('siteRoot keeps a subdirectory install intact', () => {
  assert.equal(
    siteRoot('https://example.edu/moodle/webservice/rest/server.php'),
    'https://example.edu/moodle'
  );
});

test('normalizeSiteInput accepts a bare hostname', () => {
  assert.equal(normalizeSiteInput('mycourses.aalto.fi'), AALTO);
});

test('normalizeSiteInput strips trailing paths people copy from the address bar', () => {
  assert.equal(normalizeSiteInput(`${AALTO}/`), AALTO);
  assert.equal(normalizeSiteInput(`${AALTO}/my/`), AALTO);
  assert.equal(normalizeSiteInput(`${AALTO}/my`), AALTO);
  assert.equal(normalizeSiteInput(`${AALTO}/login/index.php`), AALTO);
  assert.equal(normalizeSiteInput(`${AALTO}/?foo=bar`), AALTO);
});

test('normalizeSiteInput strips surrounding quotes and whitespace', () => {
  assert.equal(normalizeSiteInput('  "mycourses.aalto.fi"  '), AALTO);
});

test('normalizeSiteInput keeps a subdirectory install', () => {
  assert.equal(normalizeSiteInput('example.edu/moodle'), 'https://example.edu/moodle');
});

test('normalizeSiteInput refuses http:// for a remote host', () => {
  assert.throws(() => normalizeSiteInput('http://moodle.example.edu'), /unencrypted/);
});

test('normalizeSiteInput allows http:// on localhost', () => {
  assert.equal(normalizeSiteInput('http://localhost:8080'), 'http://localhost:8080');
});

test('normalizeSiteInput rejects empty input', () => {
  assert.throws(() => normalizeSiteInput('   '), /enter a Moodle site address/);
});

test('loadConfig reports missing when nothing is configured', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = { ...process.env };
  process.env.MOODLE_MCP_CONFIG_DIR = dir;
  delete process.env.MOODLE_API_URL;
  delete process.env.MOODLE_API_TOKEN;
  t.after(() => { process.env = saved; });

  const result = loadConfig();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'missing');
});

test('loadConfig reports malformed rather than falling through', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), 'not json');

  const saved = { ...process.env };
  process.env.MOODLE_MCP_CONFIG_DIR = dir;
  delete process.env.MOODLE_API_URL;
  delete process.env.MOODLE_API_TOKEN;
  t.after(() => { process.env = saved; });

  const result = loadConfig();
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'malformed');
});

test('saveConfig then loadConfig round-trips, and env overrides per field', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = { ...process.env };
  process.env.MOODLE_MCP_CONFIG_DIR = dir;
  delete process.env.MOODLE_API_URL;
  delete process.env.MOODLE_API_TOKEN;
  t.after(() => { process.env = saved; });

  const target = saveConfig({
    version: 1,
    siteUrl: AALTO,
    token: 'a'.repeat(32),
    username: 'student',
  });

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'config file must be 0600');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'config dir must be 0700');
  }

  const fromFile = loadConfig();
  assert.equal(fromFile.ok, true);
  assert.equal(fromFile.ok && fromFile.source, 'file');
  assert.equal(fromFile.ok && fromFile.config.username, 'student');

  process.env.MOODLE_API_TOKEN = 'b'.repeat(32);
  const overridden = loadConfig();
  assert.equal(overridden.ok && overridden.config.token, 'b'.repeat(32));
  assert.equal(overridden.ok && overridden.config.siteUrl, AALTO, 'siteUrl still from file');
  assert.equal(overridden.ok && overridden.source, 'env+file');
});
