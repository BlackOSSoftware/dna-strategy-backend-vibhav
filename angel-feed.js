import WebSocket from 'ws';

const feedUrl = 'wss://smartapisocket.angelone.in/smart-stream';
const exchangeTypes = {NSE:1, NFO:2, BSE:3, BFO:4, MCX:5, CDS:13};
const LTP_MODE = 1;

export function parseTick(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buffer.length < 51) return null;
  const exchangeType = buffer.readUInt8(1);
  let token = '';
  for (let index = 2; index < 27; index++) {
    const code = buffer[index];
    if (code === 0) break;
    token += String.fromCharCode(code);
  }
  const raw = Number(buffer.readBigInt64LE(43));
  const price = raw / (exchangeType === exchangeTypes.CDS ? 1e7 : 100);
  if (!token || !(price > 0)) return null;
  return {mode:buffer.readUInt8(0), exchangeType, token, price, exchangeTime:Number(buffer.readBigInt64LE(35))};
}

export class AngelFeed {
  constructor({WebSocketImpl = WebSocket, now = Date.now, heartbeatMs = 10000, staleMs = 30000} = {}) {
    this.WebSocketImpl = WebSocketImpl; this.now = now; this.heartbeatMs = heartbeatMs; this.staleMs = staleMs;
    this.prices = new Map(); this.wanted = new Map();
    this.creds = null; this.socket = null; this.open = false; this.aliveAt = 0;
    this.retry = 0; this.retryTimer = null; this.heartbeat = null; this.bearer = false; this.lastError = '';
  }
  key(exchange, token) { const type = exchangeTypes[String(exchange || '').toUpperCase()]; return type ? `${type}:${token}` : ''; }
  start(creds) {
    if (!creds?.jwt || !creds?.apiKey || !creds?.clientCode || !creds?.feedToken) return false;
    const same = this.creds && this.creds.jwt === creds.jwt && this.creds.feedToken === creds.feedToken;
    if (same && this.socket) return true;
    this.close();
    this.creds = {...creds}; this.retry = 0; this.bearer = false;
    this.connect();
    return true;
  }
  stop() { this.creds = null; this.close(); this.prices.clear(); }
  close() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearInterval(this.heartbeat); this.heartbeat = null;
    const socket = this.socket; this.socket = null; this.open = false;
    if (socket) { try { socket.removeAllListeners?.(); socket.on?.('error', () => {}); socket.terminate ? socket.terminate() : socket.close(); } catch { /* already closed */ } }
  }
  healthy() { return this.open && this.now() - this.aliveAt < this.staleMs; }
  watch(exchange, token) {
    const key = this.key(exchange, token);
    if (!key || !token) return false;
    if (!this.wanted.has(key)) {
      const [type] = key.split(':');
      this.wanted.set(key, {exchangeType:Number(type), token:String(token)});
      if (this.open) this.subscribe([this.wanted.get(key)]);
    }
    return true;
  }
  price(exchange, token) {
    if (!this.healthy()) return null;
    const entry = this.prices.get(this.key(exchange, token));
    return entry?.price > 0 ? entry.price : null;
  }
  status() { return {connected:this.healthy(), subscribed:this.wanted.size, priced:this.prices.size, lastTickAt:this.aliveAt || null, error:this.lastError || ''}; }
  subscribe(items) {
    if (!this.open || !items.length) return;
    const groups = new Map();
    for (const item of items) groups.set(item.exchangeType, [...(groups.get(item.exchangeType) || []), item.token]);
    const tokenList = [...groups.entries()].map(([exchangeType, tokens]) => ({exchangeType, tokens}));
    try { this.socket.send(JSON.stringify({correlationID:'gridpilot1', action:1, params:{mode:LTP_MODE, tokenList}})); }
    catch (error) { this.lastError = error.message; }
  }
  connect() {
    if (!this.creds) return;
    const {jwt, apiKey, clientCode, feedToken} = this.creds;
    let socket;
    try {
      socket = new this.WebSocketImpl(feedUrl, {headers:{Authorization:this.bearer ? `Bearer ${jwt}` : jwt, 'x-api-key':apiKey, 'x-client-code':clientCode, 'x-feed-token':feedToken}});
    } catch (error) { this.lastError = error.message; this.scheduleReconnect(); return; }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.open = true; this.retry = 0; this.aliveAt = this.now(); this.lastError = '';
      this.subscribe([...this.wanted.values()]);
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => { try { socket.send('ping'); } catch { /* reconnect handles it */ } }, this.heartbeatMs);
    });
    socket.on('message', (data, isBinary) => {
      if (this.socket !== socket) return;
      this.aliveAt = this.now();
      if (isBinary === false || String(data) === 'pong') return;
      const tick = parseTick(data);
      if (tick) this.prices.set(`${tick.exchangeType}:${tick.token}`, {price:tick.price, at:this.aliveAt});
    });
    socket.on('unexpected-response', (_request, response) => {
      if (this.socket !== socket) return;
      this.lastError = `Angel feed handshake failed (HTTP ${response?.statusCode || '?'})`;
      if (response?.statusCode === 401 || response?.statusCode === 403) this.bearer = !this.bearer;
    });
    socket.on('error', error => { if (this.socket === socket) this.lastError = error.message; });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.open = false; clearInterval(this.heartbeat); this.heartbeat = null; this.socket = null;
      this.scheduleReconnect();
    });
  }
  scheduleReconnect() {
    if (!this.creds || this.retryTimer) return;
    const delay = Math.min(60000, 2000 * 2 ** Math.min(this.retry, 5));
    this.retry += 1;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    this.retryTimer.unref?.();
  }
}
