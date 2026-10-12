import {WebSocket} from 'ws';

const streamUrl = 'wss://stream.sharekhan.com/skstream/api/stream';

export function createSharekhanFeed({WebSocketImpl = WebSocket} = {}) {
  let socket = null;
  let ready = false;
  let token = '';
  let apiKey = '';
  let keys = [];
  const prices = new Map();
  const candles = new Map();
  let retryAt = 0;
  let heartbeat = null;

  function send(action, name, value) {
    if (socket?.readyState !== 1) return;
    socket.send(JSON.stringify({action, key:[name], value:[value]}));
  }

  function receive(message) {
    if (Number(message?.status) !== 100) return;
    if (message.message === 'connect') {
      send('subscribe', 'feed', '');
      return;
    }
    if (message.message === 'subscribe' && /success\s*feed/i.test(String(message.data || '').trim())) {
      ready = true;
      startHeartbeat();
      if (keys.length) send('feed', 'ltp', keys.join(','));
      return;
    }
    if (message.message !== 'feed' && message.message !== 'indices') return;
    const ticks = Array.isArray(message.data) ? message.data : [message.data];
    for (const tick of ticks) {
      const code = String(tick?.scripCode ?? '');
      const id = `${tick?.exchangeCode || ''}${code}`;
      const ltp = Number(tick?.ltp);
      const match = ltp > 0 && code ? (keys.includes(id) ? id : keys.find(key => key.endsWith(code))) : '';
      if (match) {
        prices.set(match, ltp);
        rememberCandle(match, ltp, tick);
      }
    }
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    let alive = true;
    const opened = socket;
    heartbeat = setInterval(() => {
      if (socket !== opened) return;
      if (!alive) {
        try { opened.terminate?.() || opened.close(); } catch { /* A dead socket is replaced on the next watch. */ }
        return;
      }
      alive = false;
      try { opened.ping?.(); } catch { /* The server closes the feed if this socket cannot answer. */ }
    }, 30000);
    heartbeat.unref?.();
    opened?.on?.('pong', () => { alive = true; });
  }

  function connect(accessToken) {
    if (!accessToken || (socket && token === accessToken)) return;
    if (!socket && token === accessToken && Date.now() < retryAt) return;
    stop();
    token = accessToken;
    const url = new URL(streamUrl);
    url.searchParams.set('ACCESS_TOKEN', accessToken);
    url.searchParams.set('API_KEY', apiKey);
    const opened = new WebSocketImpl(url.toString());
    socket = opened;
    opened.on('message', raw => {
      try { receive(JSON.parse(String(raw))); } catch { /* Ignore a malformed feed frame. */ }
    });
    opened.on('error', () => { try { opened.close(); } catch { /* The close handler schedules the next attempt. */ } });
    opened.on('close', () => {
      if (socket !== opened) return;
      socket = null;
      ready = false;
      clearInterval(heartbeat);
      retryAt = Date.now() + 5000;
    });
  }

  function tickTime(tick) {
    const raw = String(tick?.lastUpdatedTime || tick?.lastUpdTime || tick?.ltt || '').trim();
    const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return Date.now();
    const iso = `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}T${match[4] || '00'}:${match[5] || '00'}:${match[6] || '00'}+05:30`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function bucketStart(ms) {
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(ms));
    const get = type => parts.find(part => part.type === type)?.value;
    const hour = get('hour') === '24' ? '00' : get('hour');
    const minute = String(Math.floor(Number(get('minute')) / 15) * 15).padStart(2, '0');
    return Math.floor(Date.parse(`${get('year')}-${get('month')}-${get('day')}T${hour}:${minute}:00+05:30`) / 1000);
  }

  function rememberCandle(id, ltp, tick) {
    const when = tickTime(tick);
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(when));
    const hour = parts.find(part => part.type === 'hour')?.value;
    const minute = (hour === '24' ? 0 : Number(hour)) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
    if (minute < 9 * 60 + 15 || minute >= 15 * 60 + 30) return;
    const bucket = bucketStart(when);
    const rows = candles.get(id) || [];
    const last = rows.at(-1);
    if (!last || last.time !== bucket) {
      if (last && bucket < last.time) return;
      rows.push({time:bucket, open:ltp, high:ltp, low:ltp, close:ltp});
      candles.set(id, rows.slice(-40));
      return;
    }
    last.high = Math.max(last.high, ltp);
    last.low = Math.min(last.low, ltp);
    last.close = ltp;
  }

  function candlesFor(exchange, scripCode) {
    return [...(candles.get(instrumentId(exchange, scripCode)) || [])];
  }

  function instrumentId(exchange, scripCode) {
    const code = String(scripCode || '').trim();
    if (!code) return '';
    return `${String(exchange || '').toUpperCase()}${code}`;
  }

  function quotes(symbols, nextApiKey, accessToken) {
    apiKey = nextApiKey || '';
    const next = [];
    for (const item of symbols || []) {
      const id = instrumentId(item?.exchange, item?.scripCode);
      if (id && !next.includes(id)) next.push(id);
    }
    if (!next.length || !accessToken || !apiKey) return prices;
    const changed = next.join(',') !== keys.join(',');
    if (changed) {
      keys = next;
      for (const id of [...prices.keys()]) if (!keys.includes(id)) prices.delete(id);
    }
    connect(accessToken);
    if (changed && ready) send('feed', 'ltp', keys.join(','));
    return prices;
  }

  function watch(exchange, scripCode, nextApiKey, accessToken) {
    const id = instrumentId(exchange, scripCode);
    quotes([{exchange, scripCode}], nextApiKey, accessToken);
    return id ? prices.get(id) ?? null : null;
  }

  function stop() {
    const opened = socket;
    socket = null;
    ready = false;
    clearInterval(heartbeat);
    try { opened?.close(); } catch { /* Closing a finished socket is safe. */ }
  }

  return {watch, quotes, candlesFor, stop, receive};
}
