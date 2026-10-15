import test from 'node:test';
import assert from 'node:assert/strict';
import {alignOrderContract, buildOptionOrder, optionInstrumentType, submitLiveOrder} from './sharekhan-orders.js';

const contract = {tradingSymbol:'NIFTY', exchange:'NF', scripCode:'40699', strike:22550, optionType:'CE', expiry:'06/10/2026', lotSize:65};
const order = {side:'buy', entry:79.95, quantity:1};

test('live option order uses one lot and does not send without a Sharekhan session', async () => {
  const body = buildOptionOrder({customerId:'12345', loginId:'APILOGIN', contract, order, productType:'INVESTMENT'});
  assert.equal(body.quantity, 65);
  assert.equal(body.customerId, 12345);
  assert.equal(body.channelUser, 'APILOGIN');
  assert.equal(body.transactionType, 'B');
  assert.equal(body.requestType, 'NEW');
  assert.equal(body.price, '79.95');
  assert.equal(body.instrumentType, 'OI');
  assert.equal(optionInstrumentType({tradingSymbol:'CRUDEOIL', exchange:'MX', instrumentType:'OS'}), 'OS');
  assert.equal(optionInstrumentType({tradingSymbol:'CRUDEOIL', exchange:'MX'}), 'OS');
  assert.equal(optionInstrumentType({tradingSymbol:'RELIANCE', exchange:'NF'}), 'OS');
  const aligned = alignOrderContract(
    {tradingSymbol:'CRUDEOIL', exchange:'MX', scripCode:'580478', instrumentType:'OI', strike:1, optionType:'CE', expiry:'01/01/2020', lotSize:1},
    [{scripCode:580478, tradingSymbol:'CRUDEOIL', instType:'OS', expiry:'15/10/2026', strike:8950, optionType:'CE', lotSize:100}]
  );
  assert.equal(aligned.instrumentType, 'OS');
  assert.equal(aligned.strike, 8950);
  assert.equal(aligned.lotSize, 100);
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
