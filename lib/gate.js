// Google sign-in in front of Basket. Only the Google accounts in ALLOWED_EMAILS
// get through. It is switched on by setting GOOGLE_CLIENT_ID; without it
// (local use, the demo, the tests) Basket has no Google step.
import { randomBytes } from 'node:crypto';
import { readCookie, seal, unseal } from './session.js';

export const GATE_COOKIE = 'pb_google';
const STATE_COOKIE = 'pb_oauth';
const GATE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE = 60 * 10; // 10 minutes to finish signing in

export function gateConfig(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  return {
    enabled: Boolean(clientId),
    clientId,
    clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
    allowed: new Set((env.ALLOWED_EMAILS || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    appUrl: (env.APP_URL || '').replace(/\/+$/, ''),
    authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  };
}

function cookie(name, value, maxAge, secure, sameSite = 'Strict') {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${maxAge}`, secure ? 'Secure' : null]
    .filter(Boolean).join('; ');
}

export const clearedGateCookie = (secure) => cookie(GATE_COOKIE, '', 0, secure);

// Who is signed in with Google, or null. The allow-list is checked on every
// request, so removing an address from ALLOWED_EMAILS locks that account out.
export function gateUser(req, gate, secret) {
  if (!gate.enabled) return { email: null };
  const data = unseal(readCookie(req.headers.cookie, GATE_COOKIE) || '', secret);
  if (!data || typeof data.e !== 'string' || !(data.x > Date.now())) return null;
  return gate.allowed.has(data.e) ? { email: data.e } : null;
}

function origin(req, gate) {
  if (gate.appUrl) return gate.appUrl;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${host}`;
}

function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end();
}

function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

// Handles GET /api/auth/google (start) and GET /api/auth/callback (return from Google).
// Returns true when it answered the request.
export async function handleGoogleAuth(req, res, route, { gate, secret, secure }) {
  if (route !== 'auth/google' && route !== 'auth/callback') return false;
  const back = (code) => redirect(res, `/?auth_error=${code}`, [cookie(STATE_COOKIE, '', 0, secure, 'Lax')]);

  if (!gate.enabled) {
    redirect(res, '/');
    return true;
  }
  if (!gate.clientSecret || !gate.allowed.size) {
    back('setup');
    return true;
  }
  const redirectUri = `${origin(req, gate)}/api/auth/callback`;

  if (route === 'auth/google') {
    const state = randomBytes(24).toString('base64url');
    const url = new URL(gate.authUrl);
    url.search = new URLSearchParams({
      client_id: gate.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      prompt: 'select_account',
    }).toString();
    // SameSite=Lax so the cookie comes back when Google sends the browser here.
    redirect(res, url.toString(), [cookie(STATE_COOKIE, seal({ s: state, x: Date.now() + STATE_MAX_AGE * 1000 }, secret), STATE_MAX_AGE, secure, 'Lax')]);
    return true;
  }

  // auth/callback
  const params = new URL(req.url, 'http://localhost').searchParams;
  if (params.get('error')) return back('cancelled'), true;
  const saved = unseal(readCookie(req.headers.cookie, STATE_COOKIE) || '', secret);
  const state = params.get('state');
  if (!saved || !state || saved.s !== state || !(saved.x > Date.now())) return back('expired'), true;
  const code = params.get('code');
  if (!code) return back('google'), true;

  let tokens;
  try {
    const r = await fetch(gate.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: gate.clientId,
        client_secret: gate.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15000),
    });
    tokens = await r.json();
    if (!r.ok) throw new Error(tokens && tokens.error);
  } catch (e) {
    console.error('Google token exchange failed:', e.message);
    return back('google'), true;
  }

  // The ID token came straight from Google over HTTPS, so its contents can be
  // trusted without checking the signature; we still check who it is for.
  const claims = decodeJwtPayload(tokens.id_token);
  const issuerOk = claims && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
  const audienceOk = claims && (claims.aud === gate.clientId || (Array.isArray(claims.aud) && claims.aud.includes(gate.clientId)));
  if (!issuerOk || !audienceOk || !(claims.exp * 1000 > Date.now()) || claims.email_verified === false || !claims.email) {
    return back('google'), true;
  }
  const email = String(claims.email).toLowerCase();
  if (!gate.allowed.has(email)) return back('not_allowed'), true;

  redirect(res, '/', [
    cookie(GATE_COOKIE, seal({ e: email, x: Date.now() + GATE_MAX_AGE * 1000 }, secret), GATE_MAX_AGE, secure),
    cookie(STATE_COOKIE, '', 0, secure, 'Lax'),
  ]);
  return true;
}
