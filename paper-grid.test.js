import test from 'node:test';
import assert from 'node:assert/strict';
import {Strategy} from './engine.js';
import {advancePaperGrid, seedGridOrders} from './paper-grid.js';

function boardFor(price, grid, extra = {}) {
  return {
    price,
    optionType: 'CE',
    side: 'buy',
    trailStartLeg: 3,
    trailStep: 8,
    tickSize: 0.05,
    grid,
    ...extra,
    sides: [{
      price,
      optionType: 'CE',
      side: 'buy',
      trailStartLeg: 3,
      trailStep: 8,
      tickSize: 0.05,
      grid,
      orderQuantity: 1,
      scripCode: '1',
      strike: 25000,
      expiry: '2026-01-01',
      tradingSymbol: 'NIFTY',
      lotSize: 65,
      ...extra
    }]
  };
}

const grid = [
  {level: 1, entry: 100, target: 112, stop: 80},
  {level: 2, entry: 107, target: 119, stop: 87},
  {level: 3, entry: 114, target: 126, stop: 94}
];

test('paper grid seeds drafts when empty', () => {
  const s = new Strategy({quantity: 1, maxLoss: 1e9, maxProfit: 1e9});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'existing';
  s.inSession = () => true;
  seedGridOrders(s, boardFor(100, grid));
  assert.equal(s.orders().length, 3);
  assert.ok(s.orders().every(order => order.status === 'draft'));
});

test('paper grid fills level 1 at entry then opens level 2 after fill', () => {
  const s = new Strategy({quantity: 1, maxLoss: 1e9, maxProfit: 1e9, trailStep: 8, trailStartLeg: 3});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'existing';
  s.inSession = () => true;
  advancePaperGrid(s, boardFor(100, grid));
  assert.equal(s.orders()[0].status, 'open');
  assert.equal(s.orders()[0].filled, 100);
  assert.equal(s.orders()[0].routing, 'paper');
  assert.equal(s.orders()[1].status, 'draft');
  advancePaperGrid(s, boardFor(107, grid));
  assert.equal(s.orders()[1].status, 'open');
  assert.equal(s.orders()[1].filled, 107);
});

test('paper grid exits on target and stop like live', () => {
  const s = new Strategy({quantity: 1, maxLoss: 1e9, maxProfit: 1e9, trailStep: 8, trailStartLeg: 3});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'existing';
  s.inSession = () => true;
  advancePaperGrid(s, boardFor(100, grid));
  advancePaperGrid(s, boardFor(112, grid));
  assert.equal(s.orders()[0].status, 'closed');
  assert.equal(s.orders()[0].reason, 'Target');

  const t = new Strategy({quantity: 1, maxLoss: 1e9, maxProfit: 1e9, trailStep: 8, trailStartLeg: 3});
  t.mode = 'paper';
  t.status = 'running';
  t.tradeMode = 'existing';
  t.inSession = () => true;
  advancePaperGrid(t, boardFor(100, grid));
  advancePaperGrid(t, boardFor(80, grid));
  assert.equal(t.orders()[0].status, 'closed');
  assert.equal(t.orders()[0].reason, 'Stop');
});

test('paper grid waits for next signal in live tradeMode', () => {
  const s = new Strategy({quantity: 1});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'live';
  s.signal = null;
  s.inSession = () => true;
  assert.equal(advancePaperGrid(s, boardFor(100, grid)), false);
  assert.equal(s.orders().length, 0);
});

test('paper daily max loss kills and closes open levels', () => {
  const s = new Strategy({quantity: 1, maxLoss: 500, maxProfit: 1e9});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'existing';
  s.inSession = () => true;
  const fat = [{level: 1, entry: 100, target: 200, stop: 10}];
  advancePaperGrid(s, boardFor(100, fat, {lotSize: 10}));
  assert.equal(s.orders()[0].status, 'open');
  advancePaperGrid(s, boardFor(40, fat, {lotSize: 10}));
  assert.equal(s.orders()[0].status, 'closed');
  assert.equal(s.status, 'killed');
  assert.equal(s.haltReason, 'Maximum loss');
});
