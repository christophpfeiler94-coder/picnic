// Small client for Picnic's private app API (the API the Picnic phone app uses).
// Picnic does not publish or support this API. The endpoints and fields follow
// the open-source clients python-picnic-api2 and the Home Assistant integration.
import { createHash } from 'node:crypto';

export class PicnicError extends Error {
  constructor(message, status = 502, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function picnicConfig(env = process.env) {
  const country = (env.PICNIC_COUNTRY || 'de').toLowerCase();
  const apiVersion = env.PICNIC_API_VERSION || '15';
  const host = `https://storefront-prod.${country}.picnicinternational.com`;
  return {
    baseUrl: (env.PICNIC_BASE_URL || `${host}/api/${apiVersion}`).replace(/\/$/, ''),
    imageBase: (env.PICNIC_IMAGE_BASE || `${host}/static/images`).replace(/\/$/, ''),
    agent: env.PICNIC_AGENT || '30100;1.15.272-15295;',
    deviceId: env.PICNIC_DEVICE_ID || '3C417201548B2E3B',
    clientId: 30100,
  };
}

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

export class PicnicClient {
  constructor(token = null, config = picnicConfig()) {
    this.token = token;
    this.config = config;
  }

  async request(method, path, body) {
    const headers = {
      'User-Agent': 'okhttp/4.9.0',
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      'x-picnic-agent': this.config.agent,
      'x-picnic-did': this.config.deviceId,
    };
    if (this.token) headers['x-picnic-auth'] = this.token;

    let res;
    try {
      res = await fetch(this.config.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new PicnicError('Could not reach Picnic. Check your connection and try again.', 502, 'NETWORK');
    }

    // Picnic hands out a new token on login and after the SMS check.
    const newToken = res.headers.get('x-picnic-auth');
    if (newToken) this.token = newToken;

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const err = data && typeof data === 'object' ? data.error : null;
      throw new PicnicError(
        (err && err.message) || `Picnic answered with error ${res.status}.`,
        res.status,
        (err && err.code) || null,
      );
    }
    return data;
  }

  login(email, password) {
    return this.request('POST', '/user/login', {
      key: email,
      secret: md5(password),
      client_id: this.config.clientId,
    });
  }

  send2faCode(channel = 'SMS') {
    return this.request('POST', '/user/2fa/generate', { channel });
  }

  verify2faCode(code) {
    return this.request('POST', '/user/2fa/verify', { otp: code });
  }

  getUser() {
    return this.request('GET', '/user');
  }

  async search(term) {
    const q = encodeURIComponent(term);
    let page = null;
    try {
      page = await this.request('GET', `/pages/search-page-results?search_term=${q}`);
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
    }
    // A search page with no products is a real "nothing found".
    if (page && typeof page === 'object') return extractSellingUnits(page);

    // Older API: a list of groups, each with "items".
    const groups = await this.request('GET', `/search?search_term=${q}`);
    const items = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const it of g.items || []) {
        if (it.type === 'SINGLE_ARTICLE' || (it.id && it.name)) items.push(it);
      }
    }
    return items;
  }

  getCart() {
    return this.request('GET', '/cart');
  }

  addProduct(productId, count = 1) {
    return this.request('POST', '/cart/add_product', { product_id: productId, count });
  }

  removeProduct(productId, count = 1) {
    return this.request('POST', '/cart/remove_product', { product_id: productId, count });
  }

  clearCart() {
    return this.request('POST', '/cart/clear');
  }

  getDeliverySlots() {
    return this.request('GET', '/cart/delivery_slots');
  }

  setDeliverySlot(slotId) {
    return this.request('POST', '/cart/set_delivery_slot', { slot_id: slotId });
  }
}

// The search page is a tree of layout blocks. Products sit in
// SELLING_UNIT_TILE nodes as "sellingUnit" objects.
export function extractSellingUnits(page, max = 40) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 60 || out.length >= max) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const su = node.sellingUnit || node.selling_unit;
    if (su && typeof su === 'object' && su.id && su.name && !seen.has(su.id)) {
      seen.add(su.id);
      out.push(su);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(page, 0);
  return out;
}
