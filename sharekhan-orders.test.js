import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOptionOrder, submitLiveOrder} from './sharekhan-orders.js';

const contract = {tradingSymbol:'NIFTY', exchange:'NF', scripCode:'40699', strike:22550, optionType:'CE', expiry:'06/10/2026', lotSize:65};
const order = {side:'buy', entry:79.95, quantity:1};

test('live option order uses one lot and does not send without a Sharekhan session', async () => {
  const body = buildOptionOrder({customerId:'12345', contract, order, productType:'INVESTMENT'});
  assert.equal(body.quantity, 65);
  assert.equal(body.transactionType, 'B');
  assert.equal(body.requestType, 'NEW');
  assert.equal(body.price, '79.95');
  assert.equal(body.instrumentType, 'OI');
  await assert.rejects(() => submitLiveOrder({apiKey:'key', accessToken:'', customerId:'', contract, order, fetchImpl:async () => { throw Error('should not send'); }}), /Connect Sharekhan/);
});

test('place posts the order and keeps the Sharekhan order id', async () => {
  let sent;
  const result = await submitLiveOrder({
    apiKey:'key', accessToken:'token', customerId:'12345', contract, order, productType:'INVESTMENT',
    fetchImpl:async (_url, options) => {
      sent = JSON.parse(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['access-token'], 'token');
      return {ok:true, status:200, json:async () => ({status:200, data:{orderId:'778899'}})};
    }
  });
  assert.equal(sent.quantity, 65);
  assert.equal(result.orderId, '778899');
});
