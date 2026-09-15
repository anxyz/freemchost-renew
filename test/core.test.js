const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const app = require('../renew');

const SERVER = 'https://freemchost.com/app/servers/test-node';
const config = { notify: true, tgToken: '12345:fake-token', tgChatId: '98765' };
const reply = (ok = true, status = 200) => ({ ok: status === 200, json: async () => ({ ok }) });

test('canonical URLs support current and legacy paths without duplicates', () => {
  const result = app.readConfig({ FREE_EMAIL: 'test@example.invalid', FREE_PASSWORD: '  password  ',
    SERVER_PAGE_URL: `${SERVER}\nhttps://new.freemchost.com/server/test-node` });
  assert.deepEqual(result.serverUrls, [SERVER]);
  assert.equal(result.password, '  password  ');
});

test('untrusted hosts and non-server URLs are rejected', () => {
  for (const url of ['https://freemchost.com.evil.invalid/app/servers/test', 'https://freemchost.com/login',
    'http://freemchost.com/app/servers/test', 'https://user:pass@freemchost.com/app/servers/test']) {
    assert.throws(() => app.canonicalServerUrl(url));
  }
});

test('one invalid configured URL does not get silently skipped', () => {
  assert.throws(() => app.readConfig({ FREE_EMAIL: 'test@example.invalid', FREE_PASSWORD: 'pass',
    SERVER_PAGE_URL: `${SERVER},https://elsewhere.invalid/server/x` }));
});

test('expiry supports accessibility labels, visible units and expired state', () => {
  assert.equal(app.parseExpiry('1d 2h 3m 4s remaining').totalSeconds, 93784);
  assert.equal(app.parseExpiry('01\nD\n02\nH\n03\nM').totalHours, 26.05);
  assert.equal(app.parseExpiry('Expired').totalSeconds, 0);
  assert.equal(app.parseExpiry('0d 25h 00m 00s remaining'), null);
  assert.equal(app.parseExpiry('Unavailable'), null);
});

test('any failed or unconfirmed server makes the workflow fail', () => {
  assert.equal(app.reportsExitCode([{ status: 'renewed' }, { status: 'not_due' }]), 0);
  assert.equal(app.reportsExitCode([{ status: 'renewed' }, { status: 'failed' }]), 1);
  assert.equal(app.reportsExitCode([{ status: 'uncertain' }]), 1);
  assert.equal(app.reportsExitCode([]), 1);
});

test('renewal summaries do not claim a fixed 60-hour top-up', () => {
  const result = app.buildSummary([{ status: 'renewed', before: '1小时', after: '48小时', index: 1 }],
    { GITHUB_RUN_NUMBER: '3', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '1234' });
  assert.match(result, /运行 #3 · 第 2 次尝试/);
  assert.doesNotMatch(result, /\+60h|满血/);
  assert.match(result, /actions\/runs\/1234/);
});

test('HTTP proxy credentials are separated and SOCKS authentication fails clearly', () => {
  assert.deepEqual(app.proxyOptions('http://user:p%40ss@localhost:8080'),
    { server: 'http://localhost:8080', username: 'user', password: 'p@ss' });
  assert.throws(() => app.proxyOptions('socks5://user:pass@localhost:1080'));
});

test('caption limits do not leave half a surrogate pair', () => {
  const text = app.limitText('🧪'.repeat(2000), 1024);
  assert.ok(text.length <= 1024);
  assert.ok(text.endsWith('…'));
  assert.doesNotMatch(text.slice(0, -1), /[\uD800-\uDBFF]$/);
});

test('one photo with caption is sent for a successful report', async t => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => { calls.push({ url, options }); return reply(); });
  assert.equal(await app.sendReport(config, [{ status: 'renewed', index: 1 }], Buffer.from('png'), 1), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/sendPhoto'));
  assert.match(calls[0].options.body.get('caption'), /截图：服务器 1/);
  assert.equal(calls[0].options.body.get('photo').type, 'image/png');
});

test('rejected photo falls back to plain text without HTML parsing', async t => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options }); return reply(calls.length > 1, calls.length > 1 ? 200 : 400);
  });
  assert.equal(await app.sendReport(config, [{ status: 'failed', reason: '<tag>&text' }], Buffer.from('png')), true);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.parse_mode, undefined);
  assert.match(body.text, /<tag>&text/);
});

test('API failure and non-JSON response do not count as notification success', async t => {
  t.mock.method(global, 'fetch', async () => reply(false));
  assert.equal(await app.sendReport(config, [{ status: 'failed' }]), false);
  global.fetch = async () => ({ ok: false, json: async () => { throw new Error('Not JSON'); } });
  assert.equal(await app.sendReport(config, [{ status: 'failed' }]), false);
});

test('notification errors never log the bot token', async t => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(message));
  t.mock.method(global, 'fetch', async () => { throw new Error(`failed bot${config.tgToken}`); });
  assert.equal(await app.sendReport(config, [{ status: 'failed' }]), false);
  assert.ok(!logs.join('\n').includes(config.tgToken));
});

test('disabled notifications make no requests', async t => {
  const fetch = t.mock.method(global, 'fetch', async () => reply());
  assert.equal(await app.sendReport({ ...config, notify: false }, []), null);
  assert.equal(fetch.mock.callCount(), 0);
});

test('private process output allows only fixed states and keeps exit failures', () => {
  const secret = 'private-value 203.0.113.42';
  const script = `console.log('✅ 续期已确认');console.log(${JSON.stringify(secret)});console.error(${JSON.stringify(secret)});process.exitCode=7`;
  const result = spawnSync('python3', ['scripts/private_run.py', process.execPath, '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.match(result.stdout, /✅ 续期已确认/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('child processes cannot publish arbitrary environment and summary values', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'freemc-test-'));
  try {
    const env = { ...process.env };
    const names = ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'];
    for (const name of names) { env[name] = path.join(folder, name); fs.writeFileSync(env[name], ''); }
    const script = `const fs=require('fs');for(const n of ${JSON.stringify(names)}) fs.writeFileSync(process.env[n],'private-summary');`;
    const result = spawnSync('python3', ['scripts/private_run.py', process.execPath, '-e', script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    for (const name of names) assert.equal(fs.readFileSync(env[name], 'utf8'), '');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('invalid configuration reports once and never starts a browser', async t => {
  const fetch = t.mock.method(global, 'fetch', async () => reply());
  let launches = 0;
  const code = await app.main({ TG_BOT_TOKEN: config.tgToken, TG_CHAT_ID: config.tgChatId },
    { launch: async () => { launches++; } });
  assert.equal(code, 1);
  assert.equal(launches, 0);
  assert.equal(fetch.mock.callCount(), 1);
});
