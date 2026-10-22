const chartIntervals = new Set(['1minute', '3minute', '5minute', '15minute', '30minute', '60minute']);
const frameMinutes = {'1minute':1, '3minute':3, '5minute':5, '15minute':15, '30minute':30, '60minute':60};
function normalizeInterval(value) {
  const interval = String(value || '15minute').toLowerCase();
  return chartIntervals.has(interval) ? interval : '15minute';
}
const cache = new Map();
const inflight = new Map();

function field(row, names) {
  if (Array.isArray(row)) return null;
  for (const name of names) {
    const key = Object.keys(row).find(item => item.toLowerCase() === name);
    if (key != null && row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

function candleTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  const raw = String(value).trim();
  if (/^\d{10,13}$/.test(raw)) return candleTime(Number(raw));
  const dated = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dated) {
    const iso = `${dated[3]}-${dated[2].padStart(2, '0')}-${dated[1].padStart(2, '0')}T${dated[4] || '00'}:${dated[5] || '00'}:${dated[6] || '00'}+05:30`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}+05:30`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeRow(row) {
  const source = Array.isArray(row) ? {time:row[0], open:row[1], high:row[2], low:row[3], close:row[4], volume:row[5]} : row;
  const date = field(source, ['datetime', 'date', 'tradedate', 'timestamp', 'time', 'candleTime']);
  const clock = field(source, ['bartime', 'tradetime']);
  const time = candleTime(clock && date && !String(date).includes(':') ? `${date} ${clock}` : date);
  const open = Number(field(source, ['open', 'o']));
  const high = Number(field(source, ['high', 'h']));
  const low = Number(field(source, ['low', 'l']));
  const close = Number(field(source, ['close', 'c']));
  if (time == null || ![open, high, low, close].every(Number.isFinite)) return null;
  const volume = Number(field(source, ['volume', 'vol', 'qty', 'v']));
  return {time, open, high, low, close, volume:Number.isFinite(volume) ? volume : null};
}

export function emaSeries(candles, length, pick) {
  const k = 2 / (length + 1);
  let ema = null;
  return candles.map((candle, index) => {
    if (index < length - 1) return null;
    if (ema === null) {
      let sum = 0;
      for (let offset = 0; offset < length; offset += 1) sum += pick(candles[index - offset]);
      ema = sum / length;
    } else ema = pick(candle) * k + ema * (1 - k);
    return Math.round(ema * 100) / 100;
  });
}

function withAverages(candles) {
  const emaOpen = emaSeries(candles, 5, candle => candle.open);
  const emaClose = emaSeries(candles, 6, candle => candle.close);
  return candles.map((candle, index) => ({...candle, emaOpen:emaOpen[index], emaClose:emaClose[index]}));
}

const IST_OFFSET = 19800;
const istDay = ts => Math.floor((ts + IST_OFFSET) / 86400);
const istMinuteOfDay = ts => Math.floor((((ts + IST_OFFSET) % 86400) + 86400) % 86400 / 60);

export function aggregateCandles(rows, minutes) {
  const size = Math.max(1, Number(minutes) || 1);
  if (size === 1 || !Array.isArray(rows)) return rows;
  const out = [];
  let current = null, currentKey = '';
  for (const row of rows) {
    const minute = istMinuteOfDay(row.time);
    const anchor = minute >= 555 ? 555 : 0;
    const bucket = anchor + Math.floor((minute - anchor) / size) * size;
    const key = `${istDay(row.time)}:${bucket}`;
    if (key !== currentKey) {
      current = {time:row.time - (minute - bucket) * 60, open:row.open, high:row.high, low:row.low, close:row.close, volume:row.volume};
      out.push(current);
      currentKey = key;
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume = row.volume == null && current.volume == null ? null : (Number(current.volume) || 0) + (Number(row.volume) || 0);
    }
  }
  return out;
}
export function fillIntradayGaps(candles, minutes) {
  const step = Math.max(0, Number(minutes) || 0) * 60;
  if (!step || !Array.isArray(candles) || candles.length < 2) return candles;
  const out = [candles[0]];
  for (let index = 1; index < candles.length; index++) {
    const prev = out[out.length - 1];
    const current = candles[index];
    let time = prev.time + step;
    let guard = 0;
    while (time < current.time && guard++ < 500) {
      const minute = istMinuteOfDay(time);
      if (istDay(time) === istDay(prev.time) && minute >= 555 && minute < 930) {
        out.push({time, open:prev.close, high:prev.close, low:prev.close, close:prev.close, volume:0});
      }
      time += step;
    }
    out.push(current);
  }
  return out;
}

function rowsFrom(payload) {
  const data = Array.isArray(payload) ? payload : payload?.data || payload?.candles || payload?.result || [];
  if (!Array.isArray(data)) return [];
  return data.map(normalizeRow).filter(Boolean);
}

function mergeRows(older, fresh) {
  const unique = new Map();
  for (const candle of older || []) unique.set(candle.time, candle);
  for (const candle of fresh || []) unique.set(candle.time, candle);
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

export function withLiveCandles(value, liveCandles) {
  if (!value?.candles?.length || !liveCandles?.length) return value;
  const candles = newerCandles(value.candles, liveCandles);
  if (candles.length === value.candles.length) return value;
  return {...value, candles, last:candles.at(-1)};
}
export function newerCandles(base, extra) {
  const rows = (base || []).map(({emaClose, emaOpen, ...candle}) => candle);
  const last = Number(rows.at(-1)?.time) || 0;
  const seen = new Set(rows.map(candle => candle.time));
  for (const candle of extra || []) {
    if (Number(candle.time) > last && !seen.has(candle.time)) rows.push(candle);
  }
  rows.sort((a, b) => a.time - b.time);
  return withAverages(rows).slice(-500);
}

const BASE_DAYS = 10;
const BASE_REFRESH_MS = 60_000;

async function baseRows({market, code, symbol, expiry, strike, optionType, angel}) {
  const key = `${market}:${code}:${symbol}:${expiry||''}:${strike||''}:${optionType||''}`;
  const entry = cache.get(key);
  const now = Date.now();
  if (entry?.rows?.length && now - entry.at < BASE_REFRESH_MS) return entry;
  if (entry?.until && now < entry.until) {
    if (entry.rows?.length) return entry;
    throw Error(entry.error);
  }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const last = entry?.rows?.at(-1)?.time;
    const from = new Date(last ? (last - 30 * 60) * 1000 : now - BASE_DAYS * 86400000);
    try {
      const fresh = rowsFrom(await angel.candles({exchange:market, scripCode:code, symbol, expiry, strike, optionType}, '1minute', {from, to:new Date()}));
      const rows = mergeRows(entry?.rows, fresh).slice(-BASE_DAYS * 400);
      if (!rows.length) throw Error('Angel returned no valid candles');
      const next = {rows, at:Date.now(), until:0, error:'', version:(entry?.version || 0) + 1, frames:new Map()};
      cache.set(key, next);
      return next;
    } catch (error) {
      cache.set(key, {...(entry || {}), rows:entry?.rows || null, at:entry?.at || 0, until:Date.now() + (error.retryMs || 8000), error:error.message, frames:entry?.frames || new Map()});
      if (entry?.rows?.length) return cache.get(key);
      throw error;
    }
  })();
  inflight.set(key, job);
  try { return await job; }
  finally { inflight.delete(key); }
}

export async function marketCandles({exchange, scripCode, symbol = '', expiry, strike, optionType, interval = '15minute', angel, liveCandles = []}) {
  if(!angel?.status().connected)throw Error('Connect Angel One for market data');
  const code = String(scripCode || '').trim();
  const market = String(exchange || '').trim().toUpperCase();
  const frame = normalizeInterval(interval);
  if (!code) throw Error('Choose a scrip from the search list to load the chart');
  const base = await baseRows({market, code, symbol, expiry, strike, optionType, angel});
  let value = base.frames?.get(frame);
  if (!value) {
    const candles = withAverages(aggregateCandles(fillIntradayGaps(base.rows, 1), frameMinutes[frame] || 15)).slice(-500);
    if (!candles.length) throw Error('Angel returned no valid candles');
    value = {exchange:market, scripCode:code, interval:frame, source:'angel', candles, last:candles.at(-1)};
    base.frames?.set(frame, value);
  }
  return withLiveCandles(value, frame === '15minute' ? liveCandles : []);
}
