import {liveIntents, trailOpenStops} from './live-grid.js';

export function seedGridOrders(engine, board) {
  const sides = board?.sides?.length ? board.sides : [board];
  for (const side of sides) {
    const right = side?.optionType || 'CE';
    if (engine.orders().some(order => (order.right || 'CE') === right && !order.parked) || !side?.grid?.length) continue;
    const rows = side.grid.filter(row => row.entry > 0 && row.target > 0 && row.stop > 0);
    if (!rows.length) continue;
    const made = rows.map(row => engine.draftOrder({
      ...row,
      side: side.side === 'short' ? 'short' : 'buy',
      quantity: side.orderQuantity || engine.config.quantity,
      right,
      scripCode: side.scripCode,
      strike: side.strike,
      expiry: side.expiry,
      tradingSymbol: side.tradingSymbol,
      lotSize: side.lotSize
    }));
    engine.optionOrders = [...engine.orders(), ...made];
  }
}

/** Advance paper option grid one tick: seed drafts, place/fill sequential entries, trail, exit, daily caps. */
export function advancePaperGrid(engine, board) {
  if (engine.mode !== 'paper' || engine.status !== 'running') return false;
  if (engine.tradeMode === 'live' && !(engine.signal?.spot > 0)) return false;
  if (typeof engine.inSession === 'function' && !engine.inSession()) return false;
  const sides = board?.sides?.length ? board.sides : [board];
  if (!sides.some(side => side?.price > 0)) return false;

  seedGridOrders(engine, board);
  let changed = false;

  for (const side of sides) {
    if (!(side?.price > 0)) continue;
    const right = side.optionType || 'CE';
    const orders = engine.orders().filter(order => (order.right || 'CE') === right);
    if (!orders.length) continue;
    const sideName = orders[0]?.side || side.side || 'buy';
    const before = JSON.stringify(orders);

    trailOpenStops(orders, side.price, {
      side: sideName,
      trailStartLeg: side.trailStartLeg || engine.config.trailStartLeg,
      trailStep: side.trailStep || engine.config.trailStep,
      tick: side.tickSize || engine.config.tickSize
    });

    for (const intent of liveIntents(orders, side.price, sideName)) {
      if (intent.type !== 'entry') continue;
      if (side.manageOnly) continue;
      const order = orders.find(item => item.level === intent.level);
      if (!order) continue;
      if (order.status !== 'draft' && order.status !== 'pending') continue;
      if (order.brokerOrderId) continue;
      engine.optionOrder({action: 'place', level: order.level, right, live: false});
      order.status = 'open';
      order.filled = order.entry;
      order.routing = 'paper';
      if (typeof engine.stampSignal === 'function') engine.stampSignal(order);
      const signal = order.signalSpot > 0
        ? ` · ${order.signalSide === 'short' ? 'SELL' : 'BUY'} signal ${order.signalSpot}`
        : '';
      engine.log('fill', `Paper level ${right} ${order.level} filled at ${order.filled}${signal}`);
      changed = true;
    }

    engine.markOptionPrice(side.price, right);
    if (JSON.stringify(orders) !== before) changed = true;
  }

  return changed || engine.status === 'killed';
}
