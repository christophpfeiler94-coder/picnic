// Turns Picnic's raw responses into the small shapes the web page uses.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function imageUrl(imageBase, imageId, size = 'small') {
  if (!imageId || typeof imageId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(imageId)) return null;
  return `${imageBase}/${imageId}/${size}.png`;
}

export function normalizeProduct(p, imageBase) {
  const imageId = p.image_id || (Array.isArray(p.image_ids) ? p.image_ids[0] : null);
  return {
    id: String(p.id),
    name: String(p.name || ''),
    unit: p.unit_quantity ? String(p.unit_quantity) : '',
    price: num(p.display_price) ?? num(p.price),
    maxCount: num(p.max_count),
    image: imageUrl(imageBase, imageId, 'medium'),
  };
}

function quantityOf(article) {
  const d = (article.decorators || []).find((x) => x && x.type === 'QUANTITY');
  return d && num(d.quantity) ? d.quantity : 1;
}

export function normalizeCart(cart, imageBase) {
  const byId = new Map();
  for (const line of (cart && cart.items) || []) {
    const articles = Array.isArray(line.items) ? line.items : [line];
    for (const a of articles) {
      if (!a || !a.id || (a.type && a.type !== 'ORDER_ARTICLE')) continue;
      const qty = quantityOf(a);
      const existing = byId.get(a.id);
      if (existing) {
        existing.qty += qty;
        continue;
      }
      const imageId = Array.isArray(a.image_ids) ? a.image_ids[0] : a.image_id;
      byId.set(a.id, {
        id: String(a.id),
        name: String(a.name || ''),
        unit: a.unit_quantity ? String(a.unit_quantity) : '',
        unitPrice: num(a.price) ?? num(a.display_price),
        maxCount: num(a.max_count),
        qty,
        image: imageUrl(imageBase, imageId, 'small'),
      });
    }
  }
  const items = [...byId.values()];
  const counted = items.reduce((s, i) => s + i.qty, 0);
  return {
    items,
    count: num(cart && cart.total_count) ?? counted,
    total: num(cart && cart.checkout_total_price) ?? num(cart && cart.total_price) ??
      items.reduce((s, i) => s + (i.unitPrice || 0) * i.qty, 0),
    selectedSlotId: (cart && cart.selected_slot && cart.selected_slot.slot_id) || null,
  };
}

export function normalizeSlots(raw) {
  const slots = ((raw && raw.delivery_slots) || [])
    .filter((s) => s && s.slot_id && s.window_start && s.window_end)
    .map((s) => ({
      id: String(s.slot_id),
      start: String(s.window_start),
      end: String(s.window_end),
      cutOff: s.cut_off_time ? String(s.cut_off_time) : null,
      available: s.is_available !== false,
      minimumOrder: num(s.minimum_order_value),
      reason: s.unavailability_reason ? String(s.unavailability_reason) : null,
      selected: Boolean(s.selected),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const selectedId = (raw && raw.selected_slot && raw.selected_slot.slot_id) ||
    (slots.find((s) => s.selected) || {}).id || null;
  return { slots, selectedId };
}
