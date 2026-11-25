// The Picnic login token is kept in an encrypted, HttpOnly cookie in your
// browser. The server stores nothing, so it also runs on Vercel.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const COOKIE_NAME = 'pb_session';
const MAX_AGE = 60 * 60 * 24 * 180; // 180 days

const keyFrom = (secret) => createHash('sha256').update(`picnic-basket:${secret}`).digest();

export function seal(data, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(value, secret) {
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function readCookie(header, name = COOKIE_NAME) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(data, secret, secure) {
  return [
    `${COOKIE_NAME}=${seal(data, secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${MAX_AGE}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

export function clearedCookie(secure) {
  return [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', secure ? 'Secure' : null]
    .filter(Boolean).join('; ');
}
