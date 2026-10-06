function expiryKey(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function todayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(date);
}

export function optionSide(right, direction) {
  const selected = String(right || 'AUTO').toUpperCase();
  if (selected === 'CE' || selected === 'PE') return selected;
  return direction === 'short' ? 'PE' : 'CE';
}

export function detectNiftyOption(rows, {spot, moneyness = 'ATM', depth = 1, right = 'CE', asOf = new Date()} = {}) {
  const price = Number(spot);
  if (!Number.isFinite(price) || price <= 0) throw Error('Nifty price is not available yet');
  const side = String(right || '').toUpperCase();
  if (!['CE', 'PE'].includes(side)) throw Error('Choose CE or PE');
  const money = String(moneyness || '').toUpperCase();
  if (!['ATM', 'ITM', 'OTM'].includes(money)) throw Error('Choose ITM, ATM, or OTM');
  const steps = money === 'ATM' ? 0 : Math.max(1, Math.min(10, Math.trunc(Number(depth) || 1)));
  const today = todayKey(asOf);
  const chain = rows.filter(row => String(row.tradingSymbol).toUpperCase() === 'NIFTY' && row.optionType === side && Number(row.strike) > 0 && expiryKey(row.expiry) >= today);
  if (!chain.length) throw Error('No live Nifty option expiry was found');
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
  return {
    tradingSymbol:'NIFTY', exchange:'NF', scripCode:String(match.scripCode), expiry:match.expiry, strike,
    optionType:side, moneyness:steps === 0 ? 'ATM' : money, depth:steps, lotSize:Number(match.lotSize) || 0,
    tickSize:Number(match.tickSize) > 0 ? Number(match.tickSize) : 0.05, spot:price, label:`NIFTY ${strike} ${side}`
  };
}

function moneyRound(value, tick) {
  const digits = tick >= 1 ? 0 : Math.ceil(-Math.log10(tick));
  const factor = 10 ** digits;
  return Math.round((Math.round(value / tick) * tick) * factor) / factor;
}

export function optionGridRows({price, side = 'buy', gridStep, targetPoints, initialStop, maxLegs = 4, tickSize = 0.05, trailStartLeg = 3, trailStep = 8} = {}) {
  const premium = Number(price);
  const step = Number(gridStep);
  const target = Number(targetPoints);
  const stop = Number(initialStop);
  const legs = Math.trunc(Number(maxLegs));
  const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.05;
  const sharedFrom = Math.trunc(Number(trailStartLeg) || 3);
  const trail = Number(trailStep) > 0 ? Number(trailStep) : 8;
  if (![premium, step, target, stop].every(Number.isFinite) || premium <= 0) throw Error('Option price is not available for the grid');
  const sign = side === 'short' ? -1 : 1;
  const anchor = moneyRound(premium, tick);
  return Array.from({length:legs}, (_, index) => {
    const level = index + 1;
    const entry = moneyRound(anchor + sign * step * index, tick);
    const shared = level >= sharedFrom;
    return {
      level,
      entry,
      target:moneyRound(entry + sign * target, tick),
      stop:shared ? anchor : moneyRound(entry - sign * stop, tick),
      shared,
      trailPoints:shared ? trail : stop,
      trailText:shared ? `Trail ${trail} pts` : `${stop} pt stop`,
      distance:moneyRound(entry - premium, tick)
    };
  });
}

const quoteCache = {at:0, cookie:'', books:new Map()};
const nseHeaders = {'User-Agent':'Mozilla/5.0', Accept:'application/json', Referer:'https://www.nseindia.com/'};

function nseExpiry(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return value;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${match[1]}-${months[Number(match[2]) - 1]}-${match[3]}`;
}

async function nseCookie(fetchImpl) {
  if (quoteCache.cookie && Date.now() - quoteCache.at < 120000) return quoteCache.cookie;
  const home = await fetchImpl('https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY', {headers:nseHeaders, signal:AbortSignal.timeout(8000)});
  quoteCache.cookie = (home.headers.getSetCookie?.() || []).map(item => item.split(';')[0]).join('; ');
  quoteCache.at = Date.now();
  return quoteCache.cookie;
}

async function nseChain(expiry, fetchImpl, maxAge = 15000) {
  const key = nseExpiry(expiry);
  const cached = quoteCache.books.get(key);
  if (cached && Date.now() - cached.at < maxAge) return cached.rows;
  const load = async () => {
    const response = await fetchImpl(`https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(key)}`, {
      headers:{...nseHeaders, Cookie:await nseCookie(fetchImpl)},
      signal:AbortSignal.timeout(8000)
    });
    const payload = await response.json().catch(() => null);
    const rows = payload?.records?.data;
    if (!response.ok || !Array.isArray(rows)) throw Error('Option price is unavailable right now');
    quoteCache.books.set(key, {at:Date.now(), rows});
    return rows;
  };
  try { return await load(); }
  catch (error) {
    quoteCache.cookie = '';
    if (cached?.rows) return cached.rows;
    throw error;
  }
}

export async function optionPremium({expiry, strike, right, fetchImpl = fetch, maxAge = 15000}) {
  const rows = await nseChain(expiry, fetchImpl, maxAge);
  const price = Number(strike);
  const side = String(right || '').toUpperCase();
  const match = rows.find(row => Number(row.strikePrice) === price || Number(row[side]?.strikePrice) === price);
  const quote = match?.[side];
  const last = Number(quote?.lastPrice);
  if (!Number.isFinite(last) || last <= 0) throw Error('Option price is unavailable right now');
  return {price:last, bid:Number(quote.buyPrice1) || null, ask:Number(quote.sellPrice1) || null, underlying:Number(quote.underlyingValue) || null};
}

export async function withOptionGrid(contract, settings, fetchImpl = fetch) {
  const quote = await optionPremium({expiry:contract.expiry, strike:contract.strike, right:contract.optionType, fetchImpl, maxAge:settings.maxAge ?? 15000});
  return {...contract, side:settings.side, price:quote.price, bid:quote.bid, ask:quote.ask, nifty:quote.underlying, grid:optionGridRows({price:quote.price, ...settings})};
}
