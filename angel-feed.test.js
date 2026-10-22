import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AngelFeed, parseTick} from './angel-feed.js';

function packet({exchangeType = 1, token = '99926000', paise = 2281135} = {}) {
  const buffer = Buffer.alloc(51);
  buffer.writeUInt8(1, 0);
  buffer.writeUInt8(exchangeType, 1);
  buffer.write(token, 2, 'ascii');
  buffer.writeBigInt64LE(7n, 27);
  buffer.writeBigInt64LE(1792560000000n, 35);
  buffer.writeBigInt64LE(BigInt(paise), 43);
  return buffer;
}

test('LTP packet is parsed from paise into rupees', () => {
  const tick = parseTick(packet());
  assert.equal(tick.token, '99926000');
  assert.equal(tick.exchangeType, 1);
  assert.equal(tick.price, 22811.35);
  assert.equal(parseTick(Buffer.alloc(10)), null);
});

test('feed subscribes watched tokens and serves fresh prices', () => {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(text); }
    terminate() {}
  }
  let clock = 1000;
  const feed = new AngelFeed({WebSocketImpl:FakeSocket, now:() => clock, heartbeatMs:60000});
  feed.watch('NSE', '99926000');
  assert.equal(feed.start({jwt:'jwt', apiKey:'key', clientCode:'C1', feedToken:'feed'}), true);
  const socket = sockets[0];
  assert.equal(socket.options.headers['x-feed-token'], 'feed');
  socket.emit('open');
  const subscribe = JSON.parse(socket.sent[0]);
  assert.equal(subscribe.action, 1);
  assert.deepEqual(subscribe.params.tokenList, [{exchangeType:1, tokens:['99926000']}]);
  feed.watch('NFO', '51353');
  assert.deepEqual(JSON.parse(socket.sent[1]).params.tokenList, [{exchangeType:2, tokens:['51353']}]);
  socket.emit('message', packet({exchangeType:2, token:'51353', paise:33535}), true);
  assert.equal(feed.price('NFO', '51353'), 335.35);
  clock += 31000;
  assert.equal(feed.price('NFO', '51353'), null);
  feed.stop();
});
