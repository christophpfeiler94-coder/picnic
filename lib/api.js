// The web page's API. Each route takes JSON, calls Picnic and answers JSON.
// Works with a plain Node http server and as a Vercel function.
import { PicnicClient, PicnicError, picnicConfig } from './picnic.js';
import { normalizeCart, normalizeProduct, normalizeSlots } from './normalize.js';
import { clearedCookie, readCookie, sessionCookie, unseal } from './session.js';

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function send(res, status, body, cookies = []) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) {
    throw new HttpError(415, 'Requests must be sent as JSON.');
  }
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(String(req.body) || '{}'); } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
}

function isSecure(req) {
  return Boolean(req.socket && req.socket.encrypted) ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function userView(u) {
  if (!u || typeof u !== 'object') return null;
  const a = u.address || {};
  const street = [a.street, [a.house_number, a.house_number_ext].filter(Boolean).join('')].filter(Boolean).join(' ');
  return {
    firstName: u.firstname ? String(u.firstname) : '',
    lastName: u.lastname ? String(u.lastname) : '',
    address: [street, [a.postcode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  };
}

function count(v) {
  const n = Number(v ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new HttpError(400, 'The amount must be a whole number from 1 to 50.');
  return n;
}

function productId(v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new HttpError(400, 'That product id is not valid.');
  return v;
}

export function createApi({ secret = process.env.SESSION_SECRET, config = picnicConfig() } = {}) {
  return async function handleApi(req, res) {
    const cookies = [];
    try {
      if (!secret || secret.length < 16) {
        throw new HttpError(500, 'The server is missing SESSION_SECRET (at least 16 characters). Set it and restart.');
      }
      const url = new URL(req.url, 'http://localhost');
      let route = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
      if (route === 'handler' || route === '') route = (url.searchParams.get('route') || '').replace(/\/+$/, '');
      const key = `${req.method} ${route}`;
      const secure = isSecure(req);
      const session = unseal(readCookie(req.headers.cookie) || '', secret);

      const save = (data) => cookies.push(sessionCookie(data, secret, secure));
      const authed = () => {
        if (!session || session.s !== 'ok' || !session.t) throw new HttpError(401, 'Please log in to Picnic.', 'LOGGED_OUT');
        return new PicnicClient(session.t, config);
      };
      // Picnic can refresh the token on any answer; keep the newest one.
      const keep = (client) => {
        if (client.token && client.token !== session.t) save({ ...session, t: client.token });
      };
      const body = req.method === 'POST' ? await readJson(req) : {};

      switch (key) {
        case 'GET session': {
          if (!session) return send(res, 200, { loggedIn: false });
          if (session.s === '2fa') return send(res, 200, { loggedIn: false, pending2fa: true });
          const client = authed();
          const user = await client.getUser();
          keep(client);
          return send(res, 200, { loggedIn: true, user: userView(user) }, cookies);
        }

        case 'POST login': {
          const email = typeof body.email === 'string' ? body.email.trim() : '';
          const password = typeof body.password === 'string' ? body.password : '';
          if (!email || email.length > 200 || !password || password.length > 200) {
            throw new HttpError(400, 'Enter the email and password of your Picnic account.');
          }
          const client = new PicnicClient(null, config);
          let result;
          try {
            result = await client.login(email, password);
          } catch (e) {
            if (e instanceof PicnicError && [400, 401, 403].includes(e.status)) {
              throw new HttpError(401, 'Picnic did not accept this email and password.', e.code);
            }
            throw e;
          }
          if (!client.token) throw new HttpError(502, 'Picnic did not send a login token. Try again later.');
          if (result && result.second_factor_authentication_required) {
            await client.send2faCode('SMS');
            save({ s: '2fa', t: client.token });
            return send(res, 200, { status: '2fa' }, cookies);
          }
          const user = await client.getUser().catch(() => null);
          save({ s: 'ok', t: client.token });
          return send(res, 200, { status: 'ok', user: userView(user) }, cookies);
        }

        case 'POST 2fa/resend': {
          if (!session || session.s !== '2fa') throw new HttpError(401, 'Please log in again.', 'LOGGED_OUT');
          const client = new PicnicClient(session.t, config);
          await client.send2faCode('SMS');
          if (client.token !== session.t) save({ s: '2fa', t: client.token });
          return send(res, 200, { ok: true }, cookies);
        }

        case 'POST 2fa/verify': {
          if (!session || session.s !== '2fa') throw new HttpError(401, 'Please log in again.', 'LOGGED_OUT');
          const code = String(body.code || '').replace(/\s+/g, '');
          if (!/^\d{4,8}$/.test(code)) throw new HttpError(400, 'Enter the code from the SMS. It has only digits.');
          const client = new PicnicClient(session.t, config);
          try {
            await client.verify2faCode(code);
          } catch (e) {
            if (e instanceof PicnicError && [400, 401, 403, 422].includes(e.status)) {
              throw new HttpError(400, 'Picnic did not accept this code. Check the SMS or send a new code.', e.code);
            }
            throw e;
          }
          const user = await client.getUser().catch(() => null);
          save({ s: 'ok', t: client.token });
          return send(res, 200, { status: 'ok', user: userView(user) }, cookies);
        }

        case 'POST logout':
          return send(res, 200, { ok: true }, [clearedCookie(secure)]);

        case 'GET search': {
          const q = (url.searchParams.get('q') || '').trim();
          if (!q) return send(res, 200, { products: [] });
          if (q.length > 100) throw new HttpError(400, 'The search is too long.');
          const client = authed();
          const raw = await client.search(q);
          keep(client);
          const products = raw.map((p) => normalizeProduct(p, config.imageBase)).filter((p) => p.id && p.name);
          return send(res, 200, { products }, cookies);
        }

        case 'GET cart': {
          const client = authed();
          const cart = normalizeCart(await client.getCart(), config.imageBase);
          keep(client);
          return send(res, 200, { cart }, cookies);
        }

        case 'POST cart/add':
        case 'POST cart/remove': {
          const client = authed();
          const id = productId(body.productId);
          const n = count(body.count);
          let raw = key === 'POST cart/add' ? await client.addProduct(id, n) : await client.removeProduct(id, n);
          if (!raw || !Array.isArray(raw.items)) raw = await client.getCart();
          keep(client);
          return send(res, 200, { cart: normalizeCart(raw, config.imageBase) }, cookies);
        }

        case 'POST cart/add-many': {
          const client = authed();
          const lines = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
          if (!lines.length) throw new HttpError(400, 'Choose at least one product.');
          const failed = [];
          let raw = null;
          for (const line of lines) {
            const id = productId(line && line.productId);
            const n = count(line && line.count);
            try {
              raw = await client.addProduct(id, n);
            } catch (e) {
              if (e instanceof PicnicError && e.status === 401) throw e;
              failed.push({ productId: id, message: e.message });
            }
          }
          if (!raw || !Array.isArray(raw.items)) raw = await client.getCart();
          keep(client);
          return send(res, 200, { cart: normalizeCart(raw, config.imageBase), failed }, cookies);
        }

        case 'POST cart/clear': {
          const client = authed();
          let raw = await client.clearCart();
          if (!raw || !Array.isArray(raw.items)) raw = await client.getCart();
          keep(client);
          return send(res, 200, { cart: normalizeCart(raw, config.imageBase) }, cookies);
        }

        case 'GET slots': {
          const client = authed();
          const slots = normalizeSlots(await client.getDeliverySlots());
          keep(client);
          return send(res, 200, slots, cookies);
        }

        case 'POST slots/select': {
          const client = authed();
          const slotId = body.slotId;
          if (typeof slotId !== 'string' || !ID_RE.test(slotId)) throw new HttpError(400, 'That delivery slot is not valid.');
          await client.setDeliverySlot(slotId);
          const slots = normalizeSlots(await client.getDeliverySlots());
          keep(client);
          return send(res, 200, slots, cookies);
        }

        default:
          throw new HttpError(404, 'Unknown request.');
      }
    } catch (e) {
      if (e instanceof PicnicError && e.status === 401) {
        return send(res, 401, { error: 'Your Picnic login has expired. Please log in again.', code: 'LOGGED_OUT' },
          [clearedCookie(isSecure(req))]);
      }
      if (e instanceof HttpError) {
        return send(res, e.status, { error: e.message, code: e.code }, cookies);
      }
      if (e instanceof PicnicError) {
        return send(res, e.status >= 400 && e.status < 600 ? e.status : 502,
          { error: `Picnic: ${e.message}`, code: e.code }, cookies);
      }
      console.error(e);
      return send(res, 500, { error: 'Something went wrong on the server.' }, cookies);
    }
  };
}
