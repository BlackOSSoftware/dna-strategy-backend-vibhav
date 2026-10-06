import test from 'node:test';
import assert from 'node:assert/strict';
import {detectNiftyOption, optionGridRows, optionSide} from './options.js';

const asOf = new Date('2026-10-05T08:30:00+05:30');
const rows = [];
for (const expiry of ['29/09/2026', '06/10/2026', '13/10/2026']) {
  for (const strike of [22400, 22450, 22500, 22550, 22600]) {
    for (const optionType of ['CE', 'PE']) {
      rows.push({tradingSymbol:'NIFTY', expiry, strike, optionType, scripCode:strike + (optionType === 'CE' ? 1 : 2), lotSize:65, tickSize:0.05});
    }
  }
}

test('nearest expiry and moneyness around the Nifty price', () => {
  assert.equal(optionSide('AUTO', 'buy'), 'CE');
  assert.equal(optionSide('AUTO', 'short'), 'PE');
  assert.equal(optionSide('PE', 'buy'), 'PE');
  const atm = detectNiftyOption(rows, {spot:22510, moneyness:'ATM', right:'CE', asOf});
  assert.equal(atm.expiry, '06/10/2026');
  assert.equal(atm.strike, 22500);
  assert.equal(atm.moneyness, 'ATM');
  assert.equal(detectNiftyOption(rows, {spot:22510, moneyness:'ITM', depth:1, right:'CE', asOf}).strike, 22450);
  assert.equal(detectNiftyOption(rows, {spot:22510, moneyness:'OTM', depth:2, right:'CE', asOf}).strike, 22600);
  assert.equal(detectNiftyOption(rows, {spot:22510, moneyness:'ITM', depth:1, right:'PE', asOf}).strike, 22550);
  assert.equal(detectNiftyOption(rows, {spot:22510, moneyness:'OTM', depth:1, right:'PE', asOf}).strike, 22450);
});

test('option premium grid is independent of the Nifty index', () => {
  const buy = optionGridRows({price:93.4, side:'buy', gridStep:7, targetPoints:12, initialStop:20, maxLegs:4, tickSize:0.05, trailStartLeg:3});
  assert.deepEqual(buy.map(row => [row.level, row.entry, row.target, row.stop, row.shared]), [
    [1, 93.4, 105.4, 73.4, false],
    [2, 100.4, 112.4, 80.4, false],
    [3, 107.4, 119.4, 93.4, true],
    [4, 114.4, 126.4, 93.4, true]
  ]);
  const short = optionGridRows({price:93.4, side:'short', gridStep:7, targetPoints:12, initialStop:20, maxLegs:2, tickSize:0.05, trailStartLeg:3});
  assert.equal(short[0].target, 81.4);
  assert.equal(short[1].entry, 86.4);
});
