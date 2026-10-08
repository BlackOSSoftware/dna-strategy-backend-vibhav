import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBrokerFills, liveIntents, trailOpenStops} from './live-grid.js';

test('a higher buy level is not sent until the premium reaches it', () => {
  const orders = [
    {level:1, side:'buy', entry:100, target:112, stop:80, status:'draft'},
    {level:2, side:'buy', entry:107, target:119, stop:87, status:'draft'}
  ];
  assert.deepEqual(liveIntents(orders, 100).map(item => item.level), [1]);
  assert.deepEqual(liveIntents(orders, 107).map(item => item.level), [1, 2]);
});

test('an open live buy exits on the stop or target and trails after the third fill', () => {
  const orders = [
    {level:1, side:'buy', entry:100, target:112, stop:80, status:'open', brokerOrderId:'1'},
    {level:2, side:'buy', entry:107, target:119, stop:87, status:'open', brokerOrderId:'2'},
    {level:3, side:'buy', entry:114, target:126, stop:100, status:'open', brokerOrderId:'3'}
  ];
  trailOpenStops(orders, 116, {trailStartLeg:3, trailStep:8});
  assert.equal(orders[0].stop, 100);
  trailOpenStops(orders, 124, {trailStartLeg:3, trailStep:8});
  assert.ok(orders[0].stop > 100);
  assert.equal(liveIntents(orders, orders[0].stop).find(item => item.level === 1).reason, 'stop');
  orders[0].stop = 80;
  assert.equal(liveIntents([{...orders[0], stop:80}], 112)[0].reason, 'target');
});

test('an exchange rejection stays rejected and is not sent again', () => {
  const orders = [{level:1, side:'buy', entry:43.9, target:55.9, stop:23.9, status:'pending', brokerOrderId:'210003475'}];
  applyBrokerFills(orders, [{orderId:'210003475', status:'Exchange Rejected', reason:'You have insufficient funds. You require Rs. 289.20 to place this order'}]);
  assert.equal(orders[0].status, 'rejected');
  assert.equal(orders[0].brokerOrderId, '210003475');
  assert.match(orders[0].rejectReason, /insufficient funds/);
  assert.deepEqual(liveIntents(orders, 80), []);
});

test('broker fills open the entry and close the exit once', () => {
  const orders = [{level:1, side:'buy', entry:100, target:112, stop:80, status:'pending', brokerOrderId:'9', exitBrokerOrderId:'', exitReason:'target'}];
  applyBrokerFills(orders, [{orderId:'9', status:'Fully Executed', quantity:'65', filled:'65', price:100}]);
  assert.equal(orders[0].status, 'open');
  orders[0].exitBrokerOrderId = '10';
  let closed = 0;
  applyBrokerFills(orders, [{orderId:'10', status:'Fully Executed', quantity:'65', filled:'65', price:112}], () => { closed += 1; orders[0].status = 'closed'; });
  applyBrokerFills(orders, [{orderId:'10', status:'Fully Executed', quantity:'65', filled:'65', price:112}], () => { closed += 1; });
  assert.equal(closed, 1);
});
