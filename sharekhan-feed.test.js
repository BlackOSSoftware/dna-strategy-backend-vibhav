import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createSharekhanFeed} from './sharekhan-feed.js';

class FakeSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.latest = this;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
}

test('Sharekhan live feed subscribes to the chart scrip and keeps its price', () => {
  const feed = createSharekhanFeed({WebSocketImpl:FakeSocket});
  assert.equal(feed.watch('NC', '20000', 'key', 'token'), null);
  const socket = FakeSocket.latest;
  assert.equal(new URL(socket.url).searchParams.get('ACCESS_TOKEN'), 'token');
  socket.emit('message', JSON.stringify({status:100, message:'connect'}));
  assert.equal(socket.sent[0].action, 'subscribe');
  socket.emit('message', JSON.stringify({status:100, message:'subscribe', data:'success feed'}));
  assert.equal(socket.sent.at(-1).value[0], 'NC20000');
  socket.emit('message', JSON.stringify({status:100, message:'feed', data:{exchangeCode:'NC', scripCode:'20000', ltp:22555.8}}));
  assert.equal(feed.watch('NC', '20000', 'key', 'token'), 22555.8);
  const both = feed.quotes([{exchange:'NC', scripCode:'20000'}, {exchange:'NF', scripCode:'50001'}], 'key', 'token');
  assert.equal(socket.sent.at(-1).value[0], 'NC20000,NF50001');
  socket.emit('message', JSON.stringify({status:100, message:'feed', data:[{exchangeCode:'NC', scripCode:'20000', ltp:22510}, {exchangeCode:'NF', scripCode:'50001', ltp:48.5}]}));
  assert.equal(both.get('NC20000'), 22510);
  assert.equal(both.get('NF50001'), 48.5);
  feed.stop();
});
