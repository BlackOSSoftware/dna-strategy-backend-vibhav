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

function withAverages(candles) {
  const average = (length, pick) => candles.map((_, index) => {
    if (index < length - 1) return null;
    let sum = 0;
    for (let offset = 0; offset < length; offset += 1) sum += pick(candles[index - offset]);
    return Math.round((sum / length) * 100) / 100;
  });
  const closeAverage = average(5, candle => candle.close);
  const openAverage = average(6, candle => candle.open);
  return candles.map((candle, index) => ({...candle, smaClose:closeAverage[index], smaOpen:openAverage[index]}));
}

const istDay = ts => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(ts * 1000));
const istMinuteOfDay = ts => {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(ts * 1000));
  return Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
};
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

function candlesFrom(payload, minutes = 0) {
  const data = Array.isArray(payload) ? payload : payload?.data || payload?.candles || payload?.result || [];
  if (!Array.isArray(data)) return [];
  const candles = data.map(normalizeRow).filter(Boolean);
  const unique = new Map();
  for (const candle of candles) unique.set(candle.time, candle);
  const sorted = [...unique.values()].sort((a, b) => a.time - b.time);
  return withAverages(fillIntradayGaps(sorted, minutes)).slice(-500);
}

export function withLiveCandles(value, liveCandles) {
  if (!value?.candles?.length || !liveCandles?.length) return value;
  const candles = newerCandles(value.candles, liveCandles);
  if (candles.length === value.candles.length) return value;
  return {...value, candles, last:candles.at(-1)};
}
export function newerCandles(base, extra) {
  const rows = (base || []).map(({smaClose, smaOpen, ...candle}) => candle);
  const last = Number(rows.at(-1)?.time) || 0;
  const seen = new Set(rows.map(candle => candle.time));
  for (const candle of extra || []) {
    if (Number(candle.time) > last && !seen.has(candle.time)) rows.push(candle);
  }
  rows.sort((a, b) => a.time - b.time);
  return withAverages(rows).slice(-500);
}

export async function marketCandles({exchange, scripCode, symbol = '', expiry, strike, optionType, interval = '15minute', angel, liveCandles = []}) {
  if(!angel?.status().connected)throw Error('Connect Angel One for market data');
  const code = String(scripCode || '').trim();
  const market = String(exchange || '').trim().toUpperCase();
  const frame = normalizeInterval(interval);
  if (!code) throw Error('Choose a scrip from the search list to load the chart');
  const finish = value => withLiveCandles(value, frame === '15minute' ? liveCandles : []);
  const cacheKey = `${market}:${code}:${symbol}:${expiry||''}:${strike||''}:${frame}:angel`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  const frameMs = (frameMinutes[frame] || 15) * 60 * 1000;
  if (cached?.value && now - cached.at < Math.min(120_000, frameMs)) return finish(cached.value);
  if (cached?.error && now < cached.until) {
    if (cached.value) return finish(cached.value);
    throw Error(cached.error);
  }
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const job = loadCandles({market, code, symbol, expiry, strike, optionType, interval:frame, angel, cacheKey, previous:cached?.value || null});
  inflight.set(cacheKey, job);
  try { return finish(await job); }
  finally { inflight.delete(cacheKey); }
}

async function loadCandles({market, code, symbol, expiry, strike, optionType, interval, angel, cacheKey, previous}) {
  if(!angel)throw Error('Angel market data is not configured');
  let value;
  try{
    const rows=await angel.candles({exchange:market,scripCode:code,symbol,expiry,strike,optionType},interval);
    const candles=candlesFrom(rows, frameMinutes[interval] || 0);
    if(!candles.length)throw Error('Angel returned no valid candles');
    value={exchange:market,scripCode:code,interval,source:'angel',candles,last:candles.at(-1)};
  }catch(error){
    cache.set(cacheKey,{at:Date.now(),until:Date.now()+(error.retryMs||8000),error:error.message,value:previous});
    if(previous)return previous;
    throw error;
  }
  cache.set(cacheKey, {at:Date.now(), until:0, error:'', value});
  return value;
}
