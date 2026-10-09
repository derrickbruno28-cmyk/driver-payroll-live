const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createAuth } = require('../auth');

test('OAuth flow enforces company identity, state, nonce, session and logout', async t => {
  let options;
  let payload;
  let exchanges = 0;
  const auth = createAuth({ APP_BASE_URL: 'http://localhost:3000', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' }, {
    generateAuthUrl(o) { options = o; return 'https://accounts.google.com/test'; },
    async getToken(o) { exchanges++; assert.ok(o.codeVerifier); return { tokens: { id_token: 'signed-token' } }; },
    async verifyIdToken(o) { assert.equal(o.audience, 'client'); return { getPayload: () => payload }; }
  });
  const app = express();
  let disconnected = false;
  const sockets = new Map();
  auth.install(app, { sockets: { sockets } });
  app.get('/', auth.requireLogin, (_req, res) => res.send('private'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, cookie, extra = {}) => fetch(base + url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...extra.headers }, ...extra });
  const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
  const begin = async () => {
    const r = await request('/auth/google');
    assert.equal(r.status, 302);
    assert.equal(options.hd, 'ghlogisticsllc.com');
    assert.equal(options.code_challenge_method, 'S256');
    return { cookie: cookieOf(r), state: options.state, nonce: options.nonce };
  };
  const finish = login => request(`/auth/google/callback?state=${login.state}&code=valid`, login.cookie);
  assert.equal((await request('/')).headers.get('location'), '/login');
  let login = await begin();
  assert.equal((await request(`/auth/google/callback?state=${login.state}&code=valid`)).headers.get('location'), '/login?error=expired');
  assert.equal(exchanges, 0);
  payload = { sub: '123', email: 'user@ghlogisticsllc.com', email_verified: true, hd: 'ghlogisticsllc.com', nonce: login.nonce };
  let r = await finish(login);
  assert.equal(r.headers.get('location'), '/');
  const session = r.headers.getSetCookie().find(c => c.startsWith('payroll_session=')).split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await request('/', session)).status, 200);
  assert.equal((await request('/auth/me', session)).status, 200);
  assert.equal((await finish(login)).headers.get('location'), '/login?error=expired');
  assert.equal((await request('/', 'payroll_session=forged')).headers.get('location'), '/login');
  for (const bad of [
    { email: 'user@gmail.com', hd: 'gmail.com' },
    { hd: undefined },
    { email_verified: false },
    { nonce: 'wrong' },
    { email: 'user@other.com' }
  ]) {
    login = await begin();
    payload = { sub: '123', email: 'user@ghlogisticsllc.com', email_verified: true, hd: 'ghlogisticsllc.com', nonce: login.nonce, ...bad };
    assert.equal((await finish(login)).headers.get('location'), '/login?error=domain');
  }
  assert.equal((await request('/auth/logout', session, { method: 'POST', headers: { cookie: session, origin: 'https://evil.example' } })).status, 403);
  const current = auth.session({ headers: { cookie: session } });
  sockets.set('socket', { data: { sessionId: current.id }, disconnect() { disconnected = true; } });
  assert.equal((await request('/auth/logout', session, { method: 'POST', headers: { cookie: session, origin: 'http://localhost:3000' } })).status, 204);
  assert.equal(disconnected, true);
  assert.equal((await request('/', session)).headers.get('location'), '/login');
});

test('HTTPS cookies and session expiry', async t => {
  let opts;
  const auth = createAuth({ APP_BASE_URL: 'https://payroll.example', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }, {
    generateAuthUrl(o) { opts = o; return 'https://accounts.google.com/test'; },
    async getToken() { return { tokens: { id_token: 'token' } }; },
    async verifyIdToken() { return { getPayload: () => ({ sub: 'id', email: 'a@ghlogisticsllc.com', hd: 'ghlogisticsllc.com', email_verified: true, nonce: opts.nonce }) }; }
  });
  const app = express();
  auth.install(app, { sockets: { sockets: new Map() } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/auth/google', { redirect: 'manual' });
  assert.match(r.headers.get('set-cookie'), /__Host-payroll_login=.*Secure/);
  const callback = await fetch(base + `/auth/google/callback?state=${opts.state}&code=ok`, { redirect: 'manual', headers: { cookie: r.headers.get('set-cookie').split(';')[0] } });
  assert.match(callback.headers.get('set-cookie'), /__Host-payroll_session=.*Secure/);
  const headers = { cookie: callback.headers.get('set-cookie').match(/__Host-payroll_session=[^;]+/)[0] };
  assert.ok(auth.session({ headers }));
  const now = Date.now;
  try {
    Date.now = () => now() + 9 * 60 * 60 * 1000;
    assert.equal(auth.session({ headers }), null);
  } finally { Date.now = now; }
});

test('real server blocks payroll files and unauthenticated live transport without config', async t => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: fs.mkdtempSync('/tmp/payroll-auth-test-'), STORAGE_MODE: 'file', APP_BASE_URL: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_SHEETS_SPREADSHEET_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  // Read the actual ephemeral port from startup output.
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    child.stdout.on('data', data => {
      const match = String(data).match(/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const route of ['/', '/Driver_Payroll.html']) {
    const r = await fetch(base + route, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  }
  for (const route of ['/server.js', '/data/payroll-state.json', '/.env', '/package.json']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/login')).status, 200);
  assert.equal((await fetch(base + '/auth/google')).status, 503);
  assert.equal((await fetch(base + '/socket.io/?EIO=4&transport=polling')).status, 403);
});

test('Friday payout maps to the prior completed payroll week', () => {
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'Driver_Payroll.html'), 'utf8');
  const helpers = html.slice(html.indexOf('function toYMD'), html.indexOf('function blankDays'));
  const header = html.slice(html.indexOf('function updateWeekHeader'), html.indexOf('function renderWeekTabs'));
  const nodes = {};
  const context = vm.createContext({
    cw: () => ({ startSunday: '2026-09-27' }),
    document: { getElementById: id => nodes[id] ||= {} }
  });
  vm.runInContext(helpers + header, context);
  assert.equal(vm.runInContext("normalizeWeekStart('2026-10-09')", context), '2026-09-27');
  assert.equal(vm.runInContext("normalizeWeekStart('2026-09-27')", context), '2026-09-27');
  assert.equal(vm.runInContext("normalizeWeekStart('2026-10-07')", context), '2026-10-04');
  vm.runInContext('updateWeekHeader()', context);
  assert.equal(nodes['paydate-badge'].textContent, 'Pay: Fri, Oct 9');
});
