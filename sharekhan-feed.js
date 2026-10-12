import {WebSocket} from 'ws';

const streamUrl = 'wss://stream.sharekhan.com/skstream/api/stream';

export function createSharekhanFeed({WebSocketImpl = WebSocket} = {}) {
  let socket = null;
  let ready = false;
  let token = '';
  let apiKey = '';
  let keys = [];
  const prices = new Map();
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
    if (message.message !== 'feed') return;
    const ticks = Array.isArray(message.data) ? message.data : [message.data];
    for (const tick of ticks) {
      const id = `${tick?.exchangeCode || ''}${tick?.scripCode || ''}`;
      const ltp = Number(tick?.ltp);
      if (keys.includes(id) && ltp > 0) prices.set(id, ltp);
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

  return {watch, quotes, stop, receive};
}
