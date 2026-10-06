const round = (value, tick = 0.05) => {
  const step = Number(tick) > 0 ? Number(tick) : 0.05;
  const digits = step >= 1 ? 0 : Math.ceil(-Math.log10(step));
  const factor = 10 ** digits;
  return Math.round((Math.round(value / step) * step) * factor) / factor;
};

export function trailOpenStops(orders, price, {side = 'buy', trailStartLeg = 3, trailStep = 8, tick = 0.05} = {}) {
  const open = orders.filter(order => order.status === 'open');
  if (open.length < trailStartLeg) return;
  const first = orders.slice().sort((a, b) => a.level - b.level)[0];
  if (!first || !(price > 0)) return;
  const sign = side === 'short' ? -1 : 1;
  if (first.trailAnchor == null) first.trailAnchor = price;
  const steps = Math.floor((sign * (price - first.trailAnchor)) / trailStep);
  const breakeven = first.entry;
  const trailed = steps > 0 ? round(first.entry + sign * steps * trailStep, tick) : breakeven;
  for (const order of open) {
    if (sign === 1 && trailed > order.stop) order.stop = trailed;
    if (sign === -1 && trailed < order.stop) order.stop = trailed;
  }
}

export function liveIntents(orders, price, side = 'buy', now = Date.now()) {
  const intents = [];
  for (const order of orders) {
    if (!(order.entry > 0) || !(order.stop > 0) || !(order.target > 0)) continue;
    if (order.liveHoldUntil > now) continue;
    const buy = (order.side || side) !== 'short';
    const reached = buy ? price >= order.entry : price <= order.entry;
    if (!order.brokerOrderId && (order.status === 'draft' || order.status === 'pending') && reached) {
      intents.push({type: 'entry', level: order.level, price: order.entry});
      continue;
    }
    if (order.status === 'open' && order.brokerOrderId && !order.exitBrokerOrderId) {
      const stopped = buy ? price <= order.stop : price >= order.stop;
      const target = buy ? price >= order.target : price <= order.target;
      if (stopped) intents.push({type: 'exit', level: order.level, price: order.stop, reason: 'stop'});
      else if (target) intents.push({type: 'exit', level: order.level, price: order.target, reason: 'target'});
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

export function applyBrokerFills(orders, bookOrders = [], close) {
  const byId = new Map(bookOrders.map(row => [String(row.orderId), row]));
  for (const order of orders) {
    const entry = byId.get(String(order.brokerOrderId || ''));
    if (entry && /reject|cancel/i.test(String(entry.status || '')) && order.status === 'pending') {
      order.status = 'draft';
      order.brokerOrderId = '';
      continue;
    }
    if (entry && filled(entry) && order.status === 'pending') {
      order.status = 'open';
      order.filled = order.entry;
    }
    const exit = byId.get(String(order.exitBrokerOrderId || ''));
    if (exit && filled(exit) && order.status === 'open') close(order, Number(exit.price) || order.target || order.stop, order.exitReason || 'Exit');
  }
}
