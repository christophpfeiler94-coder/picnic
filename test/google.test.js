import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMockPicnic } from '../dev/mock-picnic.js';
import { createAppServer } from '../server.js';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
let google, mock, app, base;
let nextEmail = 'me@gmail.com';
let lastTokenRequest = null;

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

before(async () => {
  // Pretend Google token endpoint.
  google = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    lastTokenRequest = new URLSearchParams(body);
    if (lastTokenRequest.get('code') !== 'good-code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: nextEmail, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 }),
    }));
  });
  const gPort = await listen(google);
  mock = createMockPicnic({ require2fa: false });
  const mPort = await listen(mock.server);
  const mb = `http://127.0.0.1:${mPort}`;
  app = createAppServer({
    secret: 'test-secret-test-secret',
    config: { baseUrl: `${mb}/api/15`, imageBase: `${mb}/static/images`, agent: 't', deviceId: 't', clientId: 30100 },
    gate: {
      enabled: true, clientId: CLIENT_ID, clientSecret: 'shh', allowed: new Set(['me@gmail.com']), appUrl: '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: `http://127.0.0.1:${gPort}/token`,
    },
  });
  base = `http://127.0.0.1:${await listen(app)}`;
});

after(() => { google.close(); mock.server.close(); app.close(); });

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    take(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i), v = pair.slice(i + 1);
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
    },
  };
}

async function get(j, path) {
  const res = await fetch(base + path, { redirect: 'manual', headers: { Cookie: j.header() } });
  j.take(res);
  return res;
}

async function post(j, path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { Cookie: j.header(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  j.take(res);
  return res;
}

async function signIn(j, code = 'good-code') {
  const start = await get(j, '/api/auth/google');
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(to.searchParams.get('redirect_uri'), `${base}/api/auth/callback`);
  return get(j, `/api/auth/callback?state=${to.searchParams.get('state')}&code=${code}`);
}

test('everything stays locked until Google sign-in', async () => {
  const j = jar();
  let r = await get(j, '/api/session');
  assert.deepEqual(await r.json(), { loggedIn: false, google: 'required' });
  r = await post(j, '/api/login', { email: 'x@example.com', password: 'demo' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'GOOGLE');
  r = await get(j, '/api/cart');
  assert.equal(r.status, 401);
});

test('the allowed Google account gets in, then logs in to Picnic', async () => {
  nextEmail = 'Me@Gmail.com';
  const j = jar();
  const back = await signIn(j);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/');
  assert.equal(lastTokenRequest.get('client_secret'), 'shh');

  let r = await get(j, '/api/session');
  assert.deepEqual(await r.json(), { loggedIn: false, googleEmail: 'me@gmail.com' });
  r = await post(j, '/api/login', { email: 'x@example.com', password: 'demo' });
  assert.equal((await r.json()).status, 'ok');
  r = await get(j, '/api/cart');
  assert.equal(r.status, 200);

  r = await post(j, '/api/logout', {});
  r = await get(j, '/api/session');
  assert.deepEqual(await r.json(), { loggedIn: false, google: 'required' });
});

test('other Google accounts are turned away', async () => {
  nextEmail = 'stranger@gmail.com';
  const j = jar();
  const back = await signIn(j);
  assert.equal(back.headers.get('location'), '/?auth_error=not_allowed');
  const r = await get(j, '/api/session');
  assert.equal((await r.json()).google, 'required');
});

test('a callback with a wrong state or bad code does not sign in', async () => {
  nextEmail = 'me@gmail.com';
  const j = jar();
  await get(j, '/api/auth/google');
  let back = await get(j, '/api/auth/callback?state=forged&code=good-code');
  assert.equal(back.headers.get('location'), '/?auth_error=expired');

  const j2 = jar();
  back = await signIn(j2, 'bad-code');
  assert.equal(back.headers.get('location'), '/?auth_error=google');
  const r = await get(j2, '/api/session');
  assert.equal((await r.json()).google, 'required');
});
