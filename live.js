import {WebSocketServer} from 'ws';

export function attachLive(server, {nextTick, intervalMs = 50}) {
  const sockets = new Set();
  let latest = null;
  const wss = new WebSocketServer({server, path:'/ws'});
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
  const run = async () => {
    if (busy) return;
    busy = true;
    const started = Date.now();
    try {
      const tick = await nextTick();
      if (tick) {
        latest = {type:'tick', at:started, took:Date.now() - started, ...tick};
        send(latest);
      }
    } catch (error) {
      latest = {type:'tick', at:started, took:Date.now() - started, error:error.message};
      send(latest);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  run();
  return {send, timer};
}
