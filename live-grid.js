const round = (value, tick = 0.05) => {
  const step = Number(tick) > 0 ? Number(tick) : 0.05;
  const digits = step >= 1 ? 0 : Math.ceil(-Math.log10(step));
  const factor = 10 ** digits;
  return Math.round((Math.round(value / step) * step) * factor) / factor;
};

export function trailOpenStops(orders, price, {side = 'buy', trailStartLeg = 3, trailStep = 8, tick = 0.05} = {}) {
  const open = orders.filter(order => order.status === 'open' && !order.parked);
  if (!open.length || !(price > 0) || !(trailStep > 0)) return;
  const sign = side === 'short' ? -1 : 1;
  const basisOf = order => Number(order.filled) > 0 ? Number(order.filled) : Number(order.entry);
  for (const order of open) {
    if (!(order.entry > 0) || !(order.stop > 0)) continue;
    if (order.baseStop == null) order.baseStop = order.stop;
    const steps = Math.floor((sign * (price - basisOf(order))) / trailStep);
    if (steps <= 0) continue;
    const trailed = round(order.baseStop + sign * steps * trailStep, tick);
    if (sign === 1 && trailed > order.stop) order.stop = trailed;
    if (sign === -1 && trailed < order.stop) order.stop = trailed;
  }
  if (open.length < trailStartLeg) return;
  const first = open.slice().sort((a, b) => a.level - b.level)[0];
  if (!first) return;
  if (first.trailAnchor == null) first.trailAnchor = price;
  const steps = Math.floor((sign * (price - first.trailAnchor)) / trailStep);
  const breakeven = basisOf(first);
  // Snap to breakeven only while live still has room. Never pull stop onto/through live
  // (same-tick L1–L3 fills used to set stop == live and wipe the book).
  const clearOfStop = sign === 1 ? price > breakeven : price < breakeven;
  if (steps <= 0 && !clearOfStop) return;
  const trailed = steps > 0 ? round(breakeven + sign * steps * trailStep, tick) : breakeven;
  for (const order of open) {
    if (sign === 1 && trailed > order.stop) order.stop = trailed;
    if (sign === -1 && trailed < order.stop) order.stop = trailed;
  }
}

export function liveIntents(orders, price, side = 'buy', now = Date.now()) {
  const intents = [];
  for (const order of orders) {
    if (order.parked) continue;
    if (!(order.entry > 0) || !(order.stop > 0) || !(order.target > 0)) continue;
    if (order.status === 'rejected' || order.liveHoldUntil > now) continue;
    const buy = (order.side || side) !== 'short';
    const reached = buy ? price >= order.entry : price <= order.entry;
    if (!order.brokerOrderId && (order.status === 'draft' || order.status === 'pending') && reached) {
      const lowerReady = orders.filter(item => item.level < order.level).every(item => item.status === 'open' || (item.status === 'closed' && /target/i.test(String(item.reason || item.exitReason || ''))));
      if (lowerReady) intents.push({type: 'entry', level: order.level, price: order.entry});
      continue;
    }
    if (order.status === 'open' && order.brokerOrderId && !order.exitBrokerOrderId) {
      const stopped = buy ? price <= order.stop : price >= order.stop;
      const target = buy ? price >= order.target : price <= order.target;
      if (stopped) intents.push({type: 'exit', level: order.level, price, reason: 'stop'});
      else if (target) intents.push({type: 'exit', level: order.level, price, reason: 'target'});
    }
  }
  return intents;
}

function filled(row) {
  if (!row) return false;
  const qty = Number(row.quantity);
  const done = Number(row.filled);
  return /complete|executed|traded|filled/i.test(String(row.status || '')) || (qty > 0 && done >= qty);
}

export function manualBrokerExits(orders, bookOrders = [], claimed = new Set()) {
  const found = [];
  const own = new Set(orders.flatMap(order => [order.brokerOrderId, order.exitBrokerOrderId]).filter(Boolean).map(String));
  for (const order of orders) {
    if (order.status !== 'open' || !order.brokerOrderId || order.exitBrokerOrderId || !order.scripCode) continue;
    const exitSide = order.side === 'short' ? 'BUY' : 'SELL';
    const match = bookOrders.find(row => {
      const id = String(row.orderId || '');
      if (!id || own.has(id) || claimed.has(id)) return false;
      if (String(row.scripCode || '') !== String(order.scripCode)) return false;
      if (String(row.side || '').toUpperCase() !== exitSide || !filled(row)) return false;
      return Number(id) > Number(order.brokerOrderId);
    });
    if (!match) continue;
    claimed.add(String(match.orderId));
    found.push({order, row:match, price:Number(match.execPrice) || Number(match.price) || 0});
  }
  return found;
}

export function applyBrokerFills(orders, bookOrders = [], close, {now = Date.now(), trustedBook = false} = {}) {
  const byId = new Map(bookOrders.map(row => [String(row.orderId), row]));
  for (const order of orders) {
    const entry = byId.get(String(order.brokerOrderId || ''));
    if (!entry && trustedBook && order.status === 'pending' && order.brokerOrderId) {
      const placed = Number(order.brokerPlacedAt) || 0;
      if (now - placed > 120000) {
        order.status = 'draft';
        order.brokerOrderId = '';
        order.brokerPlacedAt = null;
        order.staleCleared = true;
      }
      continue;
    }
    if (entry && /reject/i.test(String(entry.status || '')) && order.status === 'pending') {
      order.status = 'rejected';
      order.rejectReason = entry.reason || entry.status;
      continue;
    }
    if (entry && /cancel/i.test(String(entry.status || '')) && order.status === 'pending') {
      order.status = 'draft';
      order.brokerOrderId = '';
      continue;
    }
    if (entry && filled(entry) && order.status === 'pending') {
      order.status = 'open';
      order.filled = Number(entry.execPrice) > 0 ? Number(entry.execPrice) : order.entry;
    }
    const exit = byId.get(String(order.exitBrokerOrderId || ''));
    if (exit && filled(exit) && order.status === 'open') close(order, Number(exit.execPrice) || Number(exit.price) || order.target || order.stop, order.exitReason || 'Exit');
  }
}
