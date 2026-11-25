// A pretend Picnic server for trying the app without a real account.
// Start it with: npm run mock   (then run the app with PICNIC_BASE_URL set, see README)
// Log in with any email and the password "demo". The SMS code is 123456.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const CATALOG = [
  ['s1001', 'Weihenstephan Frische Vollmilch 3,5 %', '1 l', 145],
  ['s1002', 'Picnic Fettarme Milch 1,5 %', '1 l', 109],
  ['s1003', 'Alpro Haferdrink Barista', '1 l', 229],
  ['s1004', 'Freilandeier Größe M', '10 Stück', 329],
  ['s1005', 'Bio-Eier Größe L', '6 Stück', 299],
  ['s1006', 'Bananen', '5 Stück', 179],
  ['s1007', 'Bio-Bananen Fairtrade', '1 kg', 249],
  ['s1008', 'Äpfel Elstar', '1 kg', 279],
  ['s1009', 'Rispentomaten', '500 g', 199],
  ['s1010', 'Cherrytomaten', '250 g', 159],
  ['s1011', 'Mestemacher Vollkornbrot', '500 g', 135],
  ['s1012', 'Harry Toastbrot Weizen', '500 g', 169],
  ['s1013', 'Kerrygold Original Irische Butter', '250 g', 299],
  ['s1014', 'Gouda jung in Scheiben', '400 g', 349],
  ['s1015', 'Barilla Spaghetti n.5', '500 g', 199],
  ['s1016', 'Barilla Penne Rigate', '500 g', 199],
  ['s1017', 'Basmati Reis', '1 kg', 289],
  ['s1018', 'Tchibo Feine Milde Kaffee gemahlen', '500 g', 649],
  ['s1019', 'Griechischer Joghurt 10 %', '500 g', 189],
  ['s1020', 'Gerolsteiner Mineralwasser Sprudel', '6 x 1,5 l', 499],
  ['s1021', 'Zwiebeln', '1 kg', 129],
  ['s1022', 'Kartoffeln festkochend', '2,5 kg', 349],
  ['s1023', 'Gurke', '1 Stück', 79],
  ['s1024', 'Paprika Mix rot, gelb, grün', '3 Stück', 249],
  ['s1025', 'Mutti Passierte Tomaten', '500 g', 159],
  ['s1026', 'Hähnchenbrustfilet', '400 g', 599],
  ['s1027', 'Nutella', '450 g', 349],
  ['s1028', 'Haferflocken zart', '500 g', 89],
].map(([id, name, unit, price]) => ({ id, name, unit_quantity: unit, display_price: price, max_count: 50, image_id: `img${id}` }));

const COLORS = ['#e9c46a', '#f4a261', '#8ab17d', '#e76f51', '#a3c4bc', '#cdb4db'];

function slotsFor(now = new Date()) {
  const slots = [];
  for (let d = 1; d <= 3; d++) {
    for (const [h1, h2] of [[8, 9], [11, 12], [15, 16], [18, 19], [20, 21]]) {
      const day = new Date(now);
      day.setDate(day.getDate() + d);
      const start = new Date(day); start.setHours(h1, 0, 0, 0);
      const end = new Date(day); end.setHours(h2, 0, 0, 0);
      const cut = new Date(start); cut.setDate(cut.getDate() - 1); cut.setHours(22, 0, 0, 0);
      const full = (d + h1) % 4 === 0;
      slots.push({
        slot_id: `slot-${d}-${h1}`,
        window_start: start.toISOString(),
        window_end: end.toISOString(),
        cut_off_time: cut.toISOString(),
        is_available: !full,
        unavailability_reason: full ? 'FULLY_BOOKED' : null,
        minimum_order_value: 3500,
        selected: false,
      });
    }
  }
  return slots;
}

export function createMockPicnic({ require2fa = true } = {}) {
  const state = { cart: new Map(), slotId: null, tokens: new Map(), slots: slotsFor() };

  const cartJson = () => {
    const items = [...state.cart.entries()].map(([id, qty]) => {
      const p = CATALOG.find((x) => x.id === id);
      return {
        type: 'ORDER_LINE',
        id: `line-${id}`,
        display_price: p.display_price * qty,
        items: [{
          type: 'ORDER_ARTICLE', id, name: p.name, unit_quantity: p.unit_quantity, price: p.display_price,
          max_count: 50, image_ids: [p.image_id], decorators: [{ type: 'QUANTITY', quantity: qty }],
        }],
      };
    });
    const total = items.reduce((s, l) => s + l.display_price, 0);
    const count = [...state.cart.values()].reduce((s, n) => s + n, 0);
    return {
      type: 'ORDER', id: 'shopping_cart', items, total_count: count, total_price: total, checkout_total_price: total,
      selected_slot: state.slotId ? { slot_id: state.slotId, state: 'EXPLICIT' } : null,
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/\d+/, '');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

    const img = path.match(/^\/static\/images\/img(s\d+)\/\w+\.png$/);
    if (img) {
      const p = CATALOG.find((x) => x.id === img[1]);
      const color = COLORS[Number(img[1].slice(1)) % COLORS.length];
      const letter = p ? p.name[0] : '?';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="${color}"/><text x="50" y="64" font-family="sans-serif" font-size="44" text-anchor="middle" fill="#1f2a1f">${letter}</text></svg>`);
    }

    if (req.method === 'POST' && path === '/user/login') {
      if (body.secret !== 'fe01ce2a7fbac8fafaed7c982a04e229') { // md5("demo")
        return send(401, { error: { code: 'AUTH_INVALID_CRED', message: 'Invalid credentials' } });
      }
      const token = `pre-${Math.random().toString(36).slice(2)}`;
      state.tokens.set(token, require2fa ? 'pre' : 'full');
      return send(200, { user_id: 'u1', second_factor_authentication_required: require2fa }, { 'x-picnic-auth': token });
    }

    const token = req.headers['x-picnic-auth'];
    const level = state.tokens.get(token);
    if (!level) return send(401, { error: { code: 'AUTH_ERROR', message: 'Not logged in' } });

    if (req.method === 'POST' && path === '/user/2fa/generate') {
      console.log('[mock picnic] SMS code: 123456');
      return send(200);
    }
    if (req.method === 'POST' && path === '/user/2fa/verify') {
      if (body.otp !== '123456') return send(400, { error: { code: 'OTP_INVALID', message: 'Invalid code' } });
      const full = `full-${Math.random().toString(36).slice(2)}`;
      state.tokens.set(full, 'full');
      return send(200, undefined, { 'x-picnic-auth': full });
    }
    if (level !== 'full') return send(403, { error: { code: 'AUTH_2FA_REQUIRED', message: '2FA required' } });

    if (req.method === 'GET' && path === '/user') {
      return send(200, {
        user_id: 'u1', firstname: 'Demo', lastname: 'Kunde',
        address: { street: 'Musterstraße', house_number: 12, house_number_ext: 'a', postcode: '10115', city: 'Berlin' },
      });
    }
    if (req.method === 'GET' && path === '/pages/search-page-results') {
      const q = (url.searchParams.get('search_term') || '').toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = CATALOG.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)));
      return send(200, {
        id: 'search-page-results',
        body: {
          type: 'PML', child: {
            type: 'BLOCK', children: hits.map((p) => ({
              type: 'TILE', id: `tile-${p.id}`,
              content: { type: 'SELLING_UNIT_TILE', sellingUnit: { ...p } },
            })),
          },
        },
      });
    }
    if (req.method === 'GET' && path === '/cart') return send(200, cartJson());
    if (req.method === 'POST' && path === '/cart/add_product') {
      if (!CATALOG.some((p) => p.id === body.product_id)) return send(400, { error: { code: 'NOT_FOUND', message: 'Unknown product' } });
      state.cart.set(body.product_id, (state.cart.get(body.product_id) || 0) + (body.count || 1));
      return send(200, cartJson());
    }
    if (req.method === 'POST' && path === '/cart/remove_product') {
      const left = (state.cart.get(body.product_id) || 0) - (body.count || 1);
      if (left > 0) state.cart.set(body.product_id, left); else state.cart.delete(body.product_id);
      return send(200, cartJson());
    }
    if (req.method === 'POST' && path === '/cart/clear') {
      state.cart.clear();
      return send(200, cartJson());
    }
    if (req.method === 'GET' && path === '/cart/delivery_slots') {
      return send(200, {
        delivery_slots: state.slots.map((s) => ({ ...s, selected: s.slot_id === state.slotId })),
        selected_slot: state.slotId ? { slot_id: state.slotId, state: 'EXPLICIT' } : null,
      });
    }
    if (req.method === 'POST' && path === '/cart/set_delivery_slot') {
      const slot = state.slots.find((s) => s.slot_id === body.slot_id);
      if (!slot || !slot.is_available) return send(400, { error: { code: 'SLOT_UNAVAILABLE', message: 'Slot not available' } });
      state.slotId = slot.slot_id;
      return send(200, cartJson());
    }
    return send(404, { error: { code: 'NOT_FOUND', message: `No mock for ${req.method} ${path}` } });
  });
  return { server, state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_PORT) || 4010;
  createMockPicnic({ require2fa: process.env.MOCK_2FA !== '0' }).server.listen(port, () => {
    console.log(`Mock Picnic on http://localhost:${port}  (password "demo", SMS code 123456)`);
  });
}
