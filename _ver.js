import {readFileSync} from 'node:fs';
try { for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}
const base = 'http://127.0.0.1:4000';
let login = null;
for (const [username, password] of [[process.env.AUTH_USERNAME, process.env.AUTH_PASSWORD], ['admin', 'admin'], ['admin', 'admin123']]) {
  if (!username || !password) continue;
  const attempt = await fetch(base + '/api/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username, password})}).then(r => r.json());
  if (attempt.token) { login = attempt; break; }
}
if (!login?.token) { console.log('local login failed'); process.exit(1); }
const headers = {authorization: 'Bearer ' + login.token, 'content-type': 'application/json'};
const api = async (path, method = 'GET', body) => { const r = await fetch(base + path, {method, headers, body: body ? JSON.stringify(body) : undefined}); return r.json(); };
const angel = await api('/api/angel/status');
if (!angel?.connected) await api('/api/angel/login', 'POST', {});
const state = await api('/api/state');
const c = state.config || {};
const board = await api(`/api/option?tradeMode=existing&direction=buy&symbol=${encodeURIComponent(c.symbol)}&exchange=${encodeURIComponent(c.exchange)}&scripCode=${encodeURIComponent(c.scripCode)}`);
console.log('BOARD', board.label, '| spot =', board.spot, '| signalInfo =', JSON.stringify(board.signalInfo || null), '| interval =', c.signalInterval);
const mkt = await api(`/api/market?exchange=${encodeURIComponent(c.exchange)}&scripCode=${encodeURIComponent(c.scripCode)}&symbol=${encodeURIComponent(c.symbol || '')}&interval=${c.signalInterval || '15minute'}`);
console.log('MARKET candles =', (mkt.candles || []).length, '| error =', mkt.error || null);
