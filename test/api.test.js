import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPicnic } from '../dev/mock-picnic.js';
import { createAppServer } from '../server.js';
import { extractSellingUnits } from '../lib/picnic.js';
import { normalizeCart } from '../lib/normalize.js';
import { seal, unseal } from '../lib/session.js';

let mock, app, base, cookie = '';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

before(async () => {
  mock = createMockPicnic({ require2fa: true });
  const mockPort = await listen(mock.server);
  const mb = `http://127.0.0.1:${mockPort}`;
  app = createAppServer({
    secret: 'test-secret-test-secret',
    config: { baseUrl: `${mb}/api/15`, imageBase: `${mb}/static/images`, agent: 't', deviceId: 't', clientId: 30100 },
  });
  base = `http://127.0.0.1:${await listen(app)}`;
});

after(() => { mock.server.close(); app.close(); });

async function call(path, body) {
  const res = await fetch(`${base}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie();
  for (const c of set) {
    const v = c.split(';')[0];
    cookie = v.endsWith('=') ? '' : v;
  }
  return { status: res.status, data: await res.json(), setCookie: set };
}

test('full shopping flow against the pretend Picnic', async () => {
  let r = await call('session');
  assert.deepEqual(r.data, { loggedIn: false });

  r = await call('cart');
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'LOGGED_OUT');

  r = await call('login', { email: 'me@example.com', password: 'wrong' });
  assert.equal(r.status, 401);
  assert.match(r.data.error, /did not accept/);

  r = await call('login', { email: 'me@example.com', password: 'demo' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, '2fa');
  assert.match(r.setCookie[0], /HttpOnly; SameSite=Strict/);

  r = await call('session');
  assert.deepEqual(r.data, { loggedIn: false, pending2fa: true });
  r = await call('cart');
  assert.equal(r.status, 401, 'cart must stay locked until the SMS code is confirmed');

  r = await call('2fa/verify', { code: '000000' });
  assert.equal(r.status, 400);

  r = await call('2fa/verify', { code: '123456' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.firstName, 'Demo');
  assert.equal(r.data.user.address, 'Musterstraße 12a, 10115 Berlin');

  r = await call('session');
  assert.equal(r.data.loggedIn, true);

  r = await call('search?q=milch');
  assert.equal(r.status, 200);
  assert.ok(r.data.products.length >= 2);
  const milk = r.data.products[0];
  assert.match(milk.image, /\/static\/images\/imgs\d+\/medium\.png$/);
  assert.equal(typeof milk.price, 'number');

  r = await call('cart/add', { productId: milk.id, count: 2 });
  assert.equal(r.data.cart.count, 2);
  assert.equal(r.data.cart.items[0].qty, 2);
  assert.equal(r.data.cart.total, milk.price * 2);

  r = await call('cart/add-many', { items: [{ productId: 's1006', count: 1 }, { productId: 'nope1', count: 1 }, { productId: milk.id, count: 1 }] });
  assert.equal(r.data.cart.count, 4);
  assert.equal(r.data.failed.length, 1);
  assert.equal(r.data.failed[0].productId, 'nope1');

  r = await call('cart/remove', { productId: milk.id, count: 1 });
  assert.equal(r.data.cart.items.find((i) => i.id === milk.id).qty, 2);

  r = await call('cart/add', { productId: '<script>', count: 1 });
  assert.equal(r.status, 400);
  r = await call('cart/add', { productId: milk.id, count: 500 });
  assert.equal(r.status, 400);

  r = await call('slots');
  assert.ok(r.data.slots.length > 5);
  const free = r.data.slots.find((s) => s.available);
  const full = r.data.slots.find((s) => !s.available);
  r = await call('slots/select', { slotId: free.id });
  assert.equal(r.data.selectedId, free.id);
  r = await call('cart');
  assert.equal(r.data.cart.selectedSlotId, free.id);
  r = await call('slots/select', { slotId: full.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /^Picnic:/);

  r = await call('cart/clear', {});
  assert.equal(r.data.cart.count, 0);

  r = await call('logout', {});
  assert.equal(cookie, '');
  r = await call('cart');
  assert.equal(r.status, 401);
});

test('POST without JSON content type is refused', async () => {
  const res = await fetch(`${base}/api/logout`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(res.status, 415);
});

test('static files are served and paths cannot escape public/', async () => {
  let res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Basket<\/title>/);
  res = await fetch(`${base}/..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});

test('session cookie cannot be read or forged without the secret', () => {
  const sealed = seal({ s: 'ok', t: 'abc' }, 'secret-one-secret');
  assert.deepEqual(unseal(sealed, 'secret-one-secret'), { s: 'ok', t: 'abc' });
  assert.equal(unseal(sealed, 'another-secret-xx'), null);
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.equal(unseal(tampered, 'secret-one-secret'), null);
  assert.ok(!Buffer.from(sealed, 'base64url').toString('latin1').includes('abc'));
});

test('selling units are found anywhere in the search page tree', () => {
  const page = { body: { child: { children: [{ content: { type: 'SELLING_UNIT_TILE', sellingUnit: { id: 's1', name: 'A' } } },
    { children: [{ child: { content: { sellingUnit: { id: 's2', name: 'B' } } } }] },
    { content: { sellingUnit: { id: 's1', name: 'A again' } } }] } } };
  assert.deepEqual(extractSellingUnits(page).map((x) => x.id), ['s1', 's2']);
});

test('cart lines without a quantity decorator count as one', () => {
  const cart = normalizeCart({ items: [{ items: [{ type: 'ORDER_ARTICLE', id: 's9', name: 'X', price: 100 }] }] }, 'https://img');
  assert.equal(cart.items[0].qty, 1);
  assert.equal(cart.total, 100);
  assert.equal(cart.items[0].image, null);
});
