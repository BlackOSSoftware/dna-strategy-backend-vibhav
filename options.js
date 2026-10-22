function expiryKey(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function todayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(date);
}

const signalActions = new Set(['buy', 'sell', 'off']);
export const sideGridKeys = ['quantity', 'maxLegs', 'entryBuffer', 'gridStep', 'targetPoints', 'initialStop', 'trailStartLeg', 'trailStep', 'tickSize'];
const wholeGridKeys = new Set(['quantity', 'maxLegs', 'trailStartLeg']);

export function sideGridField(prefix, key) {
  return `${prefix}${key[0].toUpperCase()}${key.slice(1)}`;
}

export function sideGridSettings(config = {}, right = 'CE') {
  const prefix = String(right).toUpperCase() === 'PE' ? 'put' : 'call';
  const values = {};
  for (const key of sideGridKeys) {
    const named = Number(config[sideGridField(prefix, key)]);
    const shared = Number(config[key]);
    const value = Number.isFinite(named) && named > 0 ? named : shared;
    values[key] = wholeGridKeys.has(key) ? Math.trunc(value) : value;
  }
  return values;
}

export function sideActions(config = {}, signal = 'buy') {
  const mode = String(config.optionMode || '').toUpperCase();
  const rights = mode === 'PE' ? ['PE'] : mode === 'BOTH' ? ['CE', 'PE'] : mode === 'CE' ? ['CE'] : null;
  if (!rights) return null;
  const which = signal === 'sell' || signal === 'short' ? 'Sell' : 'Buy';
  return rights.flatMap(right => {
    const key = `${right === 'CE' ? 'call' : 'put'}On${which}`;
    const action = String(config[key] || 'off').toLowerCase();
    if (!signalActions.has(action) || action === 'off') return [];
    return [{right, action, side: action === 'sell' ? 'short' : 'buy'}];
  });
}

export function optionSide(right, direction) {
  const selected = String(right || 'AUTO').toUpperCase();
  if (selected === 'CE' || selected === 'PE') return selected;
  return direction === 'short' ? 'PE' : 'CE';
}

const underlyingAliases = {
  NIFTY50:'NIFTY', NIFTYBANK:'BANKNIFTY', BANKNIFTY:'BANKNIFTY',
  NIFTYFINSERVICE:'FINNIFTY', FINNIFTY:'FINNIFTY', NIFTYMIDSELECT:'MIDCPNIFTY', MIDCPNIFTY:'MIDCPNIFTY'
};

export function optionUnderlying(symbol) {
  const key = String(symbol || 'NIFTY').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return underlyingAliases[key] || key || 'NIFTY';
}

export function selectUnderlying(rows, {symbol = 'NIFTY', scripCode = '', asOf = new Date()} = {}) {
  const name = optionUnderlying(symbol);
  const selected = (rows || []).find(row => String(row.scripCode) === String(scripCode || '') && String(row.tradingSymbol).toUpperCase() === name);
  const listedOption = selected && (selected.optionType === 'CE' || selected.optionType === 'PE');
  if (selected && !listedOption) return selected;
  const today = todayKey(asOf);
  const futures = (rows || []).filter(row => String(row.tradingSymbol).toUpperCase() === name && row.optionType !== 'CE' && row.optionType !== 'PE' && expiryKey(row.expiry) >= today);
  futures.sort((a, b) => expiryKey(a.expiry).localeCompare(expiryKey(b.expiry)));
  return futures[0] || selected || null;
}

export function detectOption(rows, {symbol = 'NIFTY', exchange = 'NF', spot, moneyness = 'ATM', depth = 1, right = 'CE', asOf = new Date()} = {}) {
  const underlying = optionUnderlying(symbol);
  const price = Number(spot);
  if (!Number.isFinite(price) || price <= 0) throw Error(`${underlying} price is not available yet`);
  const side = String(right || '').toUpperCase();
  if (!['CE', 'PE'].includes(side)) throw Error('Choose CE or PE');
  const money = String(moneyness || '').toUpperCase();
  if (!['ATM', 'ITM', 'OTM'].includes(money)) throw Error('Choose ITM, ATM, or OTM');
  const steps = money === 'ATM' ? 0 : Math.max(1, Math.min(10, Math.trunc(Number(depth) || 1)));
  const today = todayKey(asOf);
  const chain = rows.filter(row => String(row.tradingSymbol).toUpperCase() === underlying && row.optionType === side && Number(row.strike) > 0 && expiryKey(row.expiry) >= today);
  if (!chain.length) throw Error(`No live ${underlying} option expiry was found`);
  const expiry = chain.map(row => row.expiry).sort((a, b) => expiryKey(a).localeCompare(expiryKey(b)))[0];
  const listed = chain.filter(row => row.expiry === expiry);
  const strikes = [...new Set(listed.map(row => Number(row.strike)))].sort((a, b) => a - b);
  let atm = strikes[0];
  let nearest = Infinity;
  for (const strike of strikes) {
    const gap = Math.abs(strike - price);
    if (gap < nearest) { nearest = gap; atm = strike; }
  }
  const atmIndex = strikes.indexOf(atm);
  const shift = steps === 0 ? 0 : (side === 'CE' ? (money === 'ITM' ? -steps : steps) : (money === 'ITM' ? steps : -steps));
  const index = atmIndex + shift;
  if (index < 0 || index >= strikes.length) throw Error(`Only ${strikes.length} strikes are listed for this expiry`);
  const strike = strikes[index];
  const match = listed.find(row => Number(row.strike) === strike);
  const market = String(exchange || 'NF').toUpperCase();
  return {
    tradingSymbol:underlying, exchange:market, scripCode:String(match.scripCode), expiry:match.expiry, strike,
    optionType:side, instrumentType:String(match.instType || '').toUpperCase(), moneyness:steps === 0 ? 'ATM' : money, depth:steps, lotSize:Number(match.lotSize) || 0,
    tickSize:Number(match.tickSize) > 0 ? Number(match.tickSize) : 0.05, spot:price, label:`${underlying} ${strike} ${side}`
  };
}

export function detectNiftyOption(rows, options = {}) {
  return detectOption(rows, {...options, symbol:'NIFTY'});
}

function moneyRound(value, tick) {
  const digits = tick >= 1 ? 0 : Math.ceil(-Math.log10(tick));
  const factor = 10 ** digits;
  return Math.round((Math.round(value / tick) * tick) * factor) / factor;
}

export function optionGridRows({price, anchor = null, side = 'buy', gridStep, targetPoints, initialStop, maxLegs = 4, tickSize = 0.05, trailStartLeg = 3, trailStep = 8} = {}) {
  const premium = Number(price);
  const step = Number(gridStep);
  const target = Number(targetPoints);
  const stop = Number(initialStop);
  const legs = Math.trunc(Number(maxLegs));
  const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.05;
  const sharedFrom = Math.trunc(Number(trailStartLeg) || 3);
  const trail = Number(trailStep) > 0 ? Number(trailStep) : 8;
  const basis = Number(anchor);
  if (![premium, step, target, stop].every(Number.isFinite) || premium <= 0) throw Error('Option price is not available for the grid');
  if (anchor != null && anchor !== '' && !(basis > 0)) throw Error('Signal premium is not available for the grid');
  const sign = side === 'short' ? -1 : 1;
  const anchorPrice = moneyRound(basis > 0 ? basis : premium, tick);
  if (!(anchorPrice > 0)) throw Error('Option premium is too small for this target or stop');
  const rows = [];
  for (let index = 0; index < legs; index++) {
    const level = index + 1;
    const entry = moneyRound(anchorPrice + sign * step * index, tick);
    const shared = level >= sharedFrom;
    const row = {
      level,
      entry,
      target:moneyRound(entry + sign * target, tick),
      stop:shared ? anchorPrice : moneyRound(entry - sign * stop, tick),
      shared,
      trailPoints:shared ? trail : stop,
      trailText:shared ? `Trail ${trail} pts` : `${stop} pt stop · trails ${trail}`,
      distance:moneyRound(entry - premium, tick)
    };
    if (!(row.entry > 0) || !(row.target > 0) || !(row.stop > 0)) break;
    rows.push(row);
  }
  if (!rows.length) throw Error('Option premium is too small for this target or stop');
  return rows;
}

export function premiumAt(candles, signalTime) {
  const target = typeof signalTime === 'number' ? (signalTime > 1e12 ? Math.floor(signalTime / 1000) : signalTime) : Math.floor(Date.parse(signalTime) / 1000);
  const rows = (candles || []).filter(candle => Number(candle?.close) > 0 && Number.isFinite(Number(candle.time)));
  if (!rows.length || !Number.isFinite(target)) return null;
  let best = null;
  let gap = Infinity;
  for (const row of rows) {
    const delta = Math.abs(Number(row.time) - target);
    if (delta < gap) { gap = delta; best = row; }
  }
  return best && gap <= 20 * 60 ? Number(best.close) : null;
}

export async function withOptionGrid(contract, settings) {
  const quote = settings.quote; if (!(Number(quote?.price) > 0)) throw Error('Angel option quote is required');
  const anchor = Number(settings.anchor) > 0 ? Number(settings.anchor) : quote.price;
  return {...contract, side:settings.side, price:quote.price, bid:quote.bid, ask:quote.ask, nifty:quote.underlying, anchor, gridSource:settings.gridSource === 'signal' ? 'signal' : 'premium', signalTime:settings.signalTime || null, grid:optionGridRows({...settings, price:quote.price, anchor})};
}
