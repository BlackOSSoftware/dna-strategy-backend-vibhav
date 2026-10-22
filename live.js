import {WebSocketServer} from 'ws';

export function attachLive(server, {nextTick, intervalMs = 1000, idleIntervalMs = 0, authorize, shouldTick}) {
  const sockets = new Set();
  let latest = null;
  const wss = new WebSocketServer({
    server,
    path:'/ws',
    verifyClient(info, callback) {
      try {
        const token = new URL(info.req.url, 'http://127.0.0.1').searchParams.get('token') || '';
        callback(!authorize || authorize(token));
      } catch {
        callback(false);
      }
    }
  });
  const send = payload => {
    const text = JSON.stringify(payload);
    for (const socket of sockets) if (socket.readyState === 1) socket.send(text);
  };
  wss.on('connection', socket => {
    sockets.add(socket);
    if (latest) socket.send(JSON.stringify(latest));
    socket.on('close', () => sockets.delete(socket));
  });
  let busy = false;
  let signature = '';
  let lastRunAt = 0;
  const run = async () => {
    if (busy) return;
    const active = !shouldTick || shouldTick();
    if (!active) {
      if (!sockets.size) return;
      const idle = typeof idleIntervalMs === 'function' ? idleIntervalMs() : idleIntervalMs;
      if (idle > 0 && Date.now() - lastRunAt < idle) return;
    }
    busy = true;
    const started = Date.now();
    lastRunAt = started;
    try {
      const tick = await nextTick();
      if (tick) {
        const nextSignature = `${tick.error || ''}|${tick.nifty ?? ''}|${tick.price ?? ''}|${(tick.orders || []).map(order => `${order.level}:${order.status}`).join(',')}`;
        latest = {type:'tick', at:started, took:Date.now() - started, ...tick};
        if (nextSignature !== signature) {
          signature = nextSignature;
          send(latest);
        }
      }
    } catch (error) {
      latest = {type:'tick', at:started, took:Date.now() - started, error:error.message};
      signature = '';
      send(latest);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  run();
  return {send, timer};
}
