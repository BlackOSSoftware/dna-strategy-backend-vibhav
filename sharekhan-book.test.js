import test from 'node:test';
import assert from 'node:assert/strict';
import {listFrom, mapOrder, mapPosition, sharekhanBook} from './sharekhan-book.js';

test('day report and net position payloads become order book rows', () => {
  const orders = listFrom({status: 200, data: [{orderId: '9001', tradingSymbol: 'NIFTY', strikePrice: '22550', optionType: 'CE', expiry: '06/10/2026', transactionType: 'B', orderQty: 65, executedQty: 65, orderPrice: '83.30', orderStatus: 'Fully Executed', productType: 'INVESTMENT', exchange: 'NF'}]});
  assert.equal(orders.length, 1);
  assert.deepEqual(mapOrder(orders[0]), {
    orderId: '9001',
    symbol: 'NIFTY 22550 CE · 06/10/2026',
    side: 'BUY',
    quantity: '65',
    filled: '65',
    price: 83.3,
    status: 'Fully Executed',
    product: 'INVESTMENT',
    exchange: 'NF'
  });
  const positions = listFrom({data: {netPositions: [{tradingSymbol: 'NIFTY', buyQty: 65, sellQty: 0, avgPrice: 83.3, ltp: 85, pnl: 110.5, productType: 'INVESTMENT'}]}});
  assert.equal(mapPosition(positions[0]).side, 'BUY');
  assert.equal(mapPosition(positions[0]).quantity, '65');
  assert.equal(mapPosition(positions[0]).pnl, 110.5);
});

test('book stays empty until Sharekhan is connected and never sends an order', async () => {
  const disconnected = await sharekhanBook({apiKey: 'key', accessToken: '', customerId: '1', fetchImpl: async () => { throw Error('should not fetch'); }});
  assert.equal(disconnected.connected, false);
  assert.match(disconnected.error, /Connect Sharekhan/);
  let method = '';
  const connected = await sharekhanBook({
    apiKey: 'key',
    accessToken: 'token',
    customerId: '12345',
    fetchImpl: async (url, options) => {
      method = options.method;
      assert.equal(options.headers['access-token'], 'token');
      assert.equal(options.body, undefined);
      const orders = url.endsWith('/reports/12345');
      return {ok: true, status: 200, json: async () => orders ? {data: []} : {data: [{tradingSymbol: 'NIFTY', netQty: -65, avgPrice: 40, pnl: -20}]}};
    }
  });
  assert.equal(method, 'GET');
  assert.equal(connected.connected, true);
  assert.equal(connected.orders.length, 0);
  assert.equal(connected.positions[0].side, 'SELL');
  assert.equal(connected.positions[0].quantity, '-65');
});

test('broker report errors are displayed instead of being shown as empty books', async () => {
  const book = await sharekhanBook({
    apiKey:'key', accessToken:'token', customerId:'12345',
    fetchImpl:async (url) => ({ok:true,status:200,json:async () => url.includes('/reports/')
      ? {status:false,message:'Report unavailable'}
      : {data:{unexpectedRows:[{netQty:65}]}}})
  });
  assert.equal(book.connected, false);
  assert.deepEqual(book.orders, []);
  assert.deepEqual(book.positions, []);
  assert.match(book.error, /Order book: Report unavailable/);
  assert.match(book.error, /Positions: Sharekhan returned an unrecognized response format/);
});

test('nested Sharekhan report lists are parsed', () => {
  assert.equal(listFrom({result:{reportList:[{orderId:'42'}]}})[0].orderId, '42');
  assert.equal(listFrom({data:'[{"orderId":"43"}]'})[0].orderId, '43');
});

test('successful null report data means there are no rows today', async () => {
  const book = await sharekhanBook({
    apiKey:'key', accessToken:'token', customerId:'12345',
    fetchImpl:async () => ({ok:true,status:200,json:async () => ({status:200,message:'Success',timestamp:'2026-10-06',data:null})})
  });
  assert.equal(book.connected, true);
  assert.equal(book.error, null);
  assert.deepEqual(book.orders, []);
  assert.deepEqual(book.positions, []);
});

test('successful no-record text is treated as an empty report', async () => {
  const book = await sharekhanBook({
    apiKey:'key', accessToken:'token', customerId:'12345',
    fetchImpl:async () => ({ok:true,status:200,json:async () => ({status:'SUCCESS',message:'orders_history',data:'No records found'})})
  });
  assert.equal(book.connected, true);
  assert.equal(book.error, null);
});

test('Sharekhan no-record marker with underscore is empty', async () => {
  const book = await sharekhanBook({
    apiKey:'key', accessToken:'token', customerId:'12345',
    fetchImpl:async () => ({ok:true,status:200,json:async () => ({status:200,message:'orders_history',data:'NO_RECORDS'})})
  });
  assert.equal(book.connected,true);
  assert.deepEqual(book.orders,[]);
});
