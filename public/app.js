// Basket: the web page. Talks only to this app's own /api, which talks to Picnic.

const $ = (id) => document.getElementById(id);
const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const money = (cents) => (typeof cents === 'number' ? euro.format(cents / 100) : '');
const TZ = 'Europe/Berlin';
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const cutFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });

const state = {
  user: null,
  cart: { items: [], count: 0, total: 0, selectedSlotId: null },
  slots: null,
  results: [],
  googleEmail: null,
  query: '',
  list: [],
  pending: new Set(),
  clearArmed: false,
};

// ---------- tiny DOM helper (text is always set as text, never as HTML) ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function thumb(src, name) {
  if (!src) return h('div', { class: 'thumb ph', 'aria-hidden': 'true' }, (name || '?').slice(0, 1));
  const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const box = h('div', { class: 'thumb' }, img);
  img.addEventListener('error', () => box.replaceWith(thumb(null, name)), { once: true });
  return box;
}

let toastTimer;
function toast(message, bad = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
}

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- API ----------
class LoggedOut extends Error {}

async function api(path, body) {
  const opts = { credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api/${path}`, opts);
  } catch {
    throw new Error('No connection to the Basket server.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && data.code === 'GOOGLE') {
    showAuth('google', data.error);
    throw new LoggedOut(data.error);
  }
  if (res.status === 401 && data.code === 'LOGGED_OUT' && !path.startsWith('login') && !path.startsWith('2fa')) {
    showAuth('login', data.error);
    throw new LoggedOut(data.error);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function fail(e) {
  if (!(e instanceof LoggedOut)) toast(e.message || 'Something went wrong.', true);
}

// ---------- screens ----------
function showAuth(step, message) {
  $('boot').hidden = true;
  $('app').hidden = true;
  $('auth').hidden = false;
  $('google-step').hidden = step !== 'google';
  $('login-form').hidden = step !== 'login';
  $('otp-form').hidden = step !== 'otp';
  const err = $(`${step === 'login' ? 'login' : step === 'otp' ? 'otp' : 'google'}-error`);
  err.textContent = message || '';
  err.hidden = !message;
  const who = $('google-who');
  who.textContent = state.googleEmail ? `Signed in with Google as ${state.googleEmail}.` : '';
  who.hidden = !state.googleEmail;
  ({ login: $('login-email'), otp: $('otp-code'), google: $('google-signin') })[step].focus();
}

const AUTH_ERRORS = {
  cancelled: 'Google sign-in was cancelled.',
  expired: 'The sign-in took too long or was started in another tab. Try again.',
  google: 'Google sign-in did not work. Try again.',
  not_allowed: 'This Google account may not use Basket. Choose another account.',
  setup: 'Google sign-in is not set up completely on the server (client secret or allowed emails missing).',
};

function takeAuthError() {
  const params = new URLSearchParams(location.search);
  const code = params.get('auth_error');
  if (!code) return null;
  history.replaceState(null, '', location.pathname);
  return AUTH_ERRORS[code] || AUTH_ERRORS.google;
}

function showApp(user) {
  state.user = user;
  $('boot').hidden = true;
  $('auth').hidden = true;
  $('app').hidden = false;
  $('who-name').textContent = user && user.firstName ? `Hi ${user.firstName}` : '';
  $('who-name').title = (user && user.address) || '';
  loadCart();
  loadSlots();
  $('search-input').focus();
}

async function boot() {
  const authError = takeAuthError();
  try {
    const s = await api('session');
    state.googleEmail = s.googleEmail || null;
    if (s.google === 'required') showAuth('google', authError);
    else if (s.loggedIn) showApp(s.user);
    else showAuth(s.pending2fa ? 'otp' : 'login');
  } catch (e) {
    if (e instanceof LoggedOut) return;
    showAuth('login', e.message);
  }
}

// ---------- login ----------
function busy(button, on, label) {
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = on;
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) return showAuth('login', 'Enter your Picnic email and password.');
  busy($('login-submit'), true, 'Logging in…');
  try {
    const r = await api('login', { email, password });
    $('login-password').value = '';
    if (r.status === '2fa') {
      showAuth('otp');
      $('otp-info').textContent = '';
    } else {
      showApp(r.user);
    }
  } catch (e) {
    showAuth('login', e.message);
  } finally {
    busy($('login-submit'), false);
  }
});

$('otp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const code = $('otp-code').value.replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) return showAuth('otp', 'Enter the code from the SMS. It has only digits.');
  busy($('otp-submit'), true, 'Checking…');
  try {
    const r = await api('2fa/verify', { code });
    $('otp-code').value = '';
    showApp(r.user);
  } catch (e) {
    if (/log in again/i.test(e.message)) showAuth('login', e.message);
    else showAuth('otp', e.message);
  } finally {
    busy($('otp-submit'), false);
  }
});

$('otp-resend').addEventListener('click', async () => {
  const b = $('otp-resend');
  b.disabled = true;
  try {
    await api('2fa/resend', {});
    $('otp-info').textContent = 'A new code is on its way.';
  } catch (e) {
    if (/log in again/i.test(e.message)) showAuth('login', e.message);
    else $('otp-info').textContent = e.message;
  } finally {
    setTimeout(() => { b.disabled = false; }, 20000);
  }
});

$('otp-cancel').addEventListener('click', async () => {
  try { await api('logout', {}); } catch { /* ignore */ }
  boot();
});

$('logout').addEventListener('click', async () => {
  try { await api('logout', {}); } catch { /* ignore */ }
  state.cart = { items: [], count: 0, total: 0, selectedSlotId: null };
  state.results = [];
  $('results').replaceChildren();
  boot();
});

// ---------- tabs ----------
function selectTab(name) {
  for (const t of ['search', 'list']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  storage.set('basket.tab', name);
}
$('tab-search').addEventListener('click', () => selectTab('search'));
$('tab-list').addEventListener('click', () => selectTab('list'));

// ---------- cart ----------
const qtyOf = (id) => (state.cart.items.find((i) => i.id === id) || {}).qty || 0;

function setCart(cart) {
  state.cart = cart;
  state.clearArmed = false;
  renderCart();
  renderResults();
}

async function loadCart() {
  try {
    const { cart } = await api('cart');
    setCart(cart);
  } catch (e) { fail(e); }
}

async function changeQty(product, delta) {
  if (state.pending.has(product.id)) return;
  state.pending.add(product.id);
  renderResults();
  renderCart();
  try {
    const { cart } = await api(delta > 0 ? 'cart/add' : 'cart/remove', { productId: product.id, count: Math.abs(delta) });
    setCart(cart);
    if (delta > 0 && qtyOf(product.id) === 1) toast(`Added ${product.name}`);
  } catch (e) {
    fail(e);
  } finally {
    state.pending.delete(product.id);
    renderResults();
    renderCart();
  }
}

function stepper(product, qty, label) {
  const pending = state.pending.has(product.id);
  const atMax = product.maxCount && qty >= product.maxCount;
  return h('div', { class: 'stepper', role: 'group', 'aria-label': `Amount of ${label}` },
    h('button', { type: 'button', 'aria-label': `One less ${label}`, disabled: pending, onclick: () => changeQty(product, -1) }, '−'),
    h('output', { 'aria-live': 'polite' }, String(qty)),
    h('button', { type: 'button', 'aria-label': `One more ${label}`, disabled: pending || atMax, onclick: () => changeQty(product, 1) }, '+'),
  );
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function renderCart() {
  const { items, count, total } = state.cart;
  $('cart-count').textContent = plural(count, 'item');
  $('cartbar-count').textContent = plural(count, 'item');
  $('cartbar-total').textContent = money(total) || money(0);
  $('cart-empty').hidden = items.length > 0;
  $('cart-foot').hidden = items.length === 0;
  $('cart-total').textContent = money(total);
  $('cart-items').replaceChildren(...items.map((it) => h('li', { class: 'cart-item' },
    thumb(it.image, it.name),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'ci-name', text: it.name }),
      h('div', { class: 'ci-sub', text: [it.unit, money(it.unitPrice)].filter(Boolean).join(' · ') }),
    ),
    h('div', { class: 'ci-right' },
      stepper(it, it.qty, it.name),
      h('span', { class: 'ci-price', text: typeof it.unitPrice === 'number' ? money(it.unitPrice * it.qty) : '' }),
    ),
  )));
  const clear = $('cart-clear');
  clear.textContent = state.clearArmed ? 'Tap again to empty the cart' : 'Empty cart';
  renderMinOrder();
}

$('cart-clear').addEventListener('click', async () => {
  if (!state.clearArmed) {
    state.clearArmed = true;
    renderCart();
    setTimeout(() => { if (state.clearArmed) { state.clearArmed = false; renderCart(); } }, 4000);
    return;
  }
  const b = $('cart-clear');
  b.disabled = true;
  try {
    const { cart } = await api('cart/clear', {});
    setCart(cart);
    toast('Cart emptied');
  } catch (e) { fail(e); } finally { b.disabled = false; }
});

// ---------- search ----------
let searchTimer;
let searchSeq = 0;

async function runSearch(q) {
  state.query = q;
  const seq = ++searchSeq;
  if (!q) {
    state.results = [];
    $('search-status').textContent = 'Type what you need. Results come straight from Picnic.';
    renderResults();
    return;
  }
  $('search-status').textContent = `Searching Picnic for “${q}”…`;
  try {
    const { products } = await api(`search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    state.results = products;
    $('search-status').textContent = products.length
      ? `${plural(products.length, 'result')} for “${q}”`
      : `Picnic has nothing for “${q}”. Try another word, e.g. in German.`;
    renderResults();
  } catch (e) {
    if (seq !== searchSeq) return;
    $('search-status').textContent = '';
    fail(e);
  }
}

$('search-input').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  const q = ev.target.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 350);
});
$('search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearTimeout(searchTimer);
  runSearch($('search-input').value.trim());
});

function renderResults() {
  $('results').replaceChildren(...state.results.map((p) => {
    const qty = qtyOf(p.id);
    return h('article', { class: qty > 0 ? 'card in-cart' : 'card' },
      thumb(p.image, p.name),
      h('div', { class: 'card-name', text: p.name, title: p.name }),
      h('div', { class: 'card-meta' },
        h('span', { class: 'card-unit', text: p.unit }),
        h('span', { class: 'price', text: money(p.price) }),
      ),
      qty > 0
        ? stepper(p, qty, p.name)
        : h('button', {
          class: 'btn btn-primary', type: 'button', disabled: state.pending.has(p.id),
          onclick: () => changeQty(p, 1),
        }, state.pending.has(p.id) ? 'Adding…' : 'Add'),
    );
  }));
}

// ---------- shopping list ----------
function parseList(text) {
  return text.split('\n').map((line) => line.replace(/^[\s*•\-–]+/, '').trim()).filter(Boolean).slice(0, 40).map((line) => {
    let m = line.match(/^(\d{1,2})\s*(?:x|×|stk\.?|stück)?\s+(.+)$/i);
    if (m) return { term: m[2].trim(), qty: Math.min(50, Math.max(1, Number(m[1]))) };
    m = line.match(/^(.+?)\s+(?:x|×)\s*(\d{1,2})$/i);
    if (m) return { term: m[1].trim(), qty: Math.min(50, Math.max(1, Number(m[2]))) };
    return { term: line, qty: 1 };
  });
}

$('list-input').value = storage.get('basket.list') || '';
$('list-input').addEventListener('input', (ev) => storage.set('basket.list', ev.target.value));

$('list-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const lines = parseList($('list-input').value);
  if (!lines.length) return toast('Write at least one item on the list.', true);
  state.list = lines.map((l) => ({ ...l, status: 'loading', options: [], choice: null }));
  renderList();
  const btn = $('list-find');
  busy(btn, true, 'Finding…');
  let next = 0;
  const worker = async () => {
    while (next < state.list.length) {
      const row = state.list[next++];
      try {
        const { products } = await api(`search?q=${encodeURIComponent(row.term)}`);
        row.options = products.slice(0, 4);
        row.choice = row.options[0] ? row.options[0].id : null;
        row.status = row.options.length ? 'ready' : 'none';
      } catch (e) {
        if (e instanceof LoggedOut) return;
        row.status = 'error';
        row.error = e.message;
      }
      renderList();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  busy(btn, false);
});

function renderList() {
  $('list-rows').replaceChildren(...state.list.map((row, i) => {
    const head = h('div', { class: 'lrow-head' },
      h('span', { class: 'lrow-term', text: row.term }),
      h('div', { class: 'lrow-tools' },
        h('div', { class: 'stepper', role: 'group', 'aria-label': `Amount of ${row.term}` },
          h('button', { type: 'button', 'aria-label': 'One less', disabled: row.qty <= 1, onclick: () => { row.qty--; renderList(); } }, '−'),
          h('output', {}, String(row.qty)),
          h('button', { type: 'button', 'aria-label': 'One more', disabled: row.qty >= 50, onclick: () => { row.qty++; renderList(); } }, '+'),
        ),
        row.status === 'ready' ? h('button', {
          class: 'btn-link', type: 'button',
          onclick: () => { row.choice = row.choice ? null : row.options[0].id; renderList(); },
        }, row.choice ? 'Skip' : 'Include') : null,
      ),
    );
    let body;
    if (row.status === 'loading') body = h('p', { class: 'muted', text: 'Searching…' });
    else if (row.status === 'none') body = h('p', { class: 'muted', text: 'Picnic has nothing for this. Try other words on the list.' });
    else if (row.status === 'error') body = h('p', { class: 'error', text: row.error });
    else if (!row.choice) body = h('p', { class: 'muted', text: 'Skipped. It won’t be added.' });
    else {
      body = h('div', { class: 'options', role: 'group', 'aria-label': `Products for ${row.term}` }, row.options.map((p) => h('button', {
        class: 'option', type: 'button', 'aria-pressed': String(row.choice === p.id), title: p.name,
        onclick: () => { row.choice = p.id; renderList(); },
      },
      thumb(p.image, p.name),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'opt-name', text: p.name }),
        h('div', { class: 'opt-sub', text: [p.unit, money(p.price)].filter(Boolean).join(' · ') }),
      ))));
    }
    return h('div', { class: `lrow${row.status === 'ready' && !row.choice ? ' skipped' : ''}`, 'data-row': i }, head, body);
  }));

  const chosen = state.list.filter((r) => r.choice);
  const done = state.list.every((r) => r.status !== 'loading');
  $('list-actions').hidden = !state.list.length || !done;
  const sum = chosen.reduce((s, r) => s + ((r.options.find((p) => p.id === r.choice) || {}).price || 0) * r.qty, 0);
  $('list-summary').textContent = chosen.length
    ? `${plural(chosen.length, 'product')} · about ${money(sum)}`
    : 'Nothing chosen yet.';
  $('list-add').disabled = !chosen.length;
}

$('list-add').addEventListener('click', async () => {
  const chosen = state.list.filter((r) => r.choice);
  if (!chosen.length) return;
  const btn = $('list-add');
  busy(btn, true, 'Adding…');
  try {
    const { cart, failed } = await api('cart/add-many', {
      items: chosen.map((r) => ({ productId: r.choice, count: r.qty })),
    });
    setCart(cart);
    if (failed && failed.length) {
      const bad = new Set(failed.map((f) => f.productId));
      state.list = state.list.filter((r) => bad.has(r.choice));
      renderList();
      toast(`${plural(chosen.length - failed.length, 'product')} added. Picnic refused ${failed.length}; they are still listed.`, true);
    } else {
      state.list = [];
      $('list-input').value = '';
      storage.set('basket.list', '');
      renderList();
      toast(`${plural(chosen.length, 'product')} added to your Picnic cart`);
    }
  } catch (e) { fail(e); } finally { busy(btn, false); }
});

// ---------- delivery slots ----------
async function loadSlots() {
  $('slots').replaceChildren(h('p', { class: 'muted', text: 'Loading delivery times…' }));
  try {
    state.slots = await api('slots');
    renderSlots();
  } catch (e) {
    if (e instanceof LoggedOut) return;
    $('slots').replaceChildren(h('p', { class: 'error', text: e.message }));
  }
}
$('slots-refresh').addEventListener('click', loadSlots);

async function chooseSlot(slot) {
  const buttons = $('slots').querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    state.slots = await api('slots/select', { slotId: slot.id });
    state.cart.selectedSlotId = state.slots.selectedId;
    toast('Delivery time saved in Picnic');
  } catch (e) { fail(e); }
  renderSlots();
}

function slotLabel(s) {
  return `${timeFmt.format(new Date(s.start))}–${timeFmt.format(new Date(s.end))}`;
}

function renderSlots() {
  const data = state.slots;
  if (!data || !data.slots.length) {
    $('slots').replaceChildren(h('p', { class: 'muted', text: 'Picnic shows no delivery times right now. Add items to the cart, then refresh.' }));
    $('slot-chosen').hidden = true;
    return;
  }
  const days = new Map();
  for (const s of data.slots) {
    const key = dayFmt.format(new Date(s.start));
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(s);
  }
  $('slots').replaceChildren(...[...days.entries()].map(([day, slots]) => h('div', { class: 'slot-day' },
    h('h3', { text: day }),
    h('div', { class: 'slot-list' }, slots.map((s) => {
      const selected = s.id === data.selectedId;
      return h('button', {
        class: 'slot', type: 'button', 'aria-pressed': String(selected), disabled: !s.available,
        'aria-label': `${day}, ${slotLabel(s)}${s.available ? '' : ', fully booked'}`,
        onclick: () => { if (!selected) chooseSlot(s); },
      }, slotLabel(s), h('small', { text: s.available ? (selected ? 'Chosen' : '') || ' ' : 'Full' }));
    })),
  )));
  const chosen = data.slots.find((s) => s.id === data.selectedId);
  const box = $('slot-chosen');
  if (chosen) {
    box.replaceChildren(
      'Delivery ', h('strong', { text: `${dayFmt.format(new Date(chosen.start))}, ${slotLabel(chosen)}` }),
      chosen.cutOff ? `. Order in the app by ${cutFmt.format(new Date(chosen.cutOff))}.` : '.',
    );
    box.hidden = false;
  } else {
    box.hidden = true;
  }
  renderMinOrder();
}

function renderMinOrder() {
  const el = $('min-order');
  const data = state.slots;
  const slot = data && data.slots.find((s) => s.id === data.selectedId);
  const min = (slot && slot.minimumOrder) || (data && data.slots.find((s) => s.minimumOrder) || {}).minimumOrder;
  const missing = min ? min - (state.cart.total || 0) : 0;
  if (state.cart.items.length && missing > 0) {
    el.textContent = `Picnic's minimum order is ${money(min)}. Add ${money(missing)} more.`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ---------- start ----------
selectTab(storage.get('basket.tab') === 'list' ? 'list' : 'search');
boot();
