const intervals = ['15minute', '15min', '15'];
const cache = new Map();

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
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}+05:30`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeRow(row) {
  const source = Array.isArray(row) ? {time:row[0], open:row[1], high:row[2], low:row[3], close:row[4], volume:row[5]} : row;
  const date = field(source, ['datetime', 'date', 'tradedate', 'timestamp', 'time', 'candleTime']);
  const clock = field(source, ['bartime']);
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

function candlesFrom(payload) {
  const data = Array.isArray(payload) ? payload : payload?.data || payload?.candles || payload?.result || [];
  if (!Array.isArray(data)) return [];
  const candles = data.map(normalizeRow).filter(Boolean);
  const unique = new Map();
  for (const candle of candles) unique.set(candle.time, candle);
  return withAverages([...unique.values()].sort((a, b) => a.time - b.time)).slice(-500);
}

async function sharekhanHistory({market, code, apiKey, accessToken, fetchImpl}) {
  let lastError = 'Sharekhan did not return 15-minute candles';
  for (const interval of intervals) {
    const response = await fetchImpl(`https://api.sharekhan.com/skapi/services/historical/${encodeURIComponent(market)}/${encodeURIComponent(code)}/${interval}`, {
      headers:{Accept:'application/json', 'api-key':apiKey, 'access-token':accessToken},
      signal:AbortSignal.timeout(20000)
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw Error('Sharekhan session is required for broker chart history');
    if (!response.ok) {
      lastError = payload?.message || payload?.errorType || `Sharekhan history failed (HTTP ${response.status})`;
      continue;
    }
    const candles = candlesFrom(payload);
    if (!candles.length) {
      lastError = 'Sharekhan returned no 15-minute candles for this scrip';
      continue;
    }
    return {exchange:market, scripCode:code, interval, source:'sharekhan', candles, last:candles.at(-1)};
  }
  throw Error(lastError);
}

async function niftyIndexCandles(fetchImpl) {
  const response = await fetchImpl('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=15m&range=5d', {
    headers:{Accept:'application/json'},
    signal:AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => null);
  const quote = payload?.chart?.result?.[0]?.indicators?.quote?.[0];
  const times = payload?.chart?.result?.[0]?.timestamp || [];
  if (!response.ok || !quote || !times.length) throw Error('Nifty 15-minute candles are unavailable right now');
  const rows = times.map((time, index) => ({
    time, open:quote.open?.[index], high:quote.high?.[index], low:quote.low?.[index], close:quote.close?.[index], volume:quote.volume?.[index]
  })).filter(row => [row.open, row.high, row.low, row.close].every(Number.isFinite));
  const candles = withAverages(rows).slice(-500);
  if (!candles.length) throw Error('Nifty 15-minute candles are unavailable right now');
  return {exchange:'NC', scripCode:'20000', interval:'15m', source:'nse-index', candles, last:candles.at(-1)};
}

function isNiftyIndex(symbol, exchange, scripCode) {
  return String(exchange).toUpperCase() === 'NC' && (String(scripCode) === '20000' || String(symbol || '').toUpperCase() === 'NIFTY');
}

export async function marketCandles({exchange, scripCode, symbol = '', apiKey, accessToken, fetchImpl = fetch}) {
  const code = String(scripCode || '').trim();
  const market = String(exchange || '').trim().toUpperCase();
  if (!code) throw Error('Choose a scrip from the search list to load the chart');
  const cacheKey = `${market}:${code}:${accessToken ? 'sharekhan' : 'index'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value;
  if (accessToken) {
    try { value = await sharekhanHistory({market, code, apiKey, accessToken, fetchImpl}); }
    catch (error) { if (!isNiftyIndex(symbol, market, code)) throw error; }
  }
  if (!value) {
    if (!isNiftyIndex(symbol, market, code)) throw Error('Connect Sharekhan to load the 15-minute chart');
    value = await niftyIndexCandles(fetchImpl);
  }
  cache.set(cacheKey, {at:Date.now(), value});
  return value;
}
