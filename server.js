// Runs the app on your own computer: node server.js, then open http://localhost:3000
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './lib/api.js';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function loadEnvFile() {
  try {
    const text = await readFile(new URL('./.env', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env file */ }
}

export function createAppServer(options = {}) {
  const api = createApi(options);
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return api(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) {
      res.statusCode = 403;
      return res.end();
    }
    try {
      const data = await readFile(file);
      res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set: using a temporary one. You will be logged out when the server restarts.');
  }
  const port = Number(process.env.PORT) || 3000;
  const { picnicConfig } = await import('./lib/picnic.js');
  createAppServer({ secret: process.env.SESSION_SECRET, config: picnicConfig() })
    .listen(port, () => console.log(`Basket is running at http://localhost:${port}`));
}
