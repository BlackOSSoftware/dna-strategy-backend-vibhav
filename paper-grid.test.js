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
  s.signal = {side: 'buy', spot: 22613.15, time: 1761623100};
  s.inSession = () => true;
  advancePaperGrid(s, boardFor(100, grid));
  assert.equal(s.orders()[0].status, 'open');
  assert.equal(s.orders()[0].filled, 100);
  assert.equal(s.orders()[0].routing, 'paper');
  assert.equal(s.orders()[0].signalSpot, 22613.15);
  assert.equal(s.orders()[0].signalSide, 'buy');
  assert.equal(s.orders()[1].status, 'draft');
  advancePaperGrid(s, boardFor(107, grid));
  assert.equal(s.orders()[1].status, 'open');
  assert.equal(s.orders()[1].filled, 107);
  assert.equal(s.orders()[1].signalSpot, 22613.15);
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

test('paper restart with stale entry below live does not instant max-profit kill', () => {
  const s = new Strategy({quantity: 65, maxLoss: 5000, maxProfit: 5000});
  s.start('buy', 'paper', {scripCode: '1', label: 'NIFTY 22700 PE', optionType: 'PE', lotSize: 65}, 'existing');
  s.inSession = () => true;
  s.status = 'killed';
  s.haltReason = 'Maximum profit';
  s.realized = 7605;
  s.manualAnchors = {PE: {price: 173.15, signalTime: 1}};
  s.optionOrders = [{id: 9, level: 1, side: 'buy', status: 'closed', routing: 'paper', right: 'PE', entry: 173.15, filled: 173.15, exit: 174.95, quantity: 65, lotSize: 65, pnl: 7605, reason: 'Maximum profit'}];
  const stale = [{level: 1, entry: 173.15, target: 185.15, stop: 153.15}, {level: 2, entry: 180.15, target: 192.15, stop: 160.15}];
  const board = price => ({optionType: 'PE', side: 'buy', price, lotSize: 65, orderQuantity: 65, grid: stale, scripCode: '1', label: 'NIFTY 22700 PE'});
  s.start('buy', 'paper', {scripCode: '1', label: 'NIFTY 22700 PE', optionType: 'PE', lotSize: 65}, 'existing');
  assert.equal(s.status, 'running');
  assert.equal(s.realized, 0);
  assert.deepEqual(s.manualAnchors, {});
  advancePaperGrid(s, board(175.05));
  assert.equal(s.status, 'running');
  assert.equal(s.realized, 0);
  const open = s.orders().find(order => order.status === 'open');
  assert.ok(open);
  assert.equal(open.filled, 175.05);
  assert.equal(open.entry, 173.15);
  assert.equal(open.target, 187.05);
  assert.equal(open.stop, 155.05);
  assert.ok(Math.abs(s.optionPnl(175.05)) < 1);
});

test('stale low buy grid keeps spacing and does not wipe L1-L3 on one tick', () => {
  const s = new Strategy({quantity: 1, maxLoss: 1e9, maxProfit: 1e9, trailStep: 8, trailStartLeg: 3, gridStep: 7, initialStop: 20, targetPoints: 12});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'existing';
  s.inSession = () => true;
  const low = [
    {level: 1, entry: 221, target: 233, stop: 201},
    {level: 2, entry: 228, target: 240, stop: 208},
    {level: 3, entry: 235, target: 247, stop: 221},
    {level: 4, entry: 242, target: 254, stop: 221}
  ];
  advancePaperGrid(s, boardFor(243.4, low));
  assert.equal(s.orders()[0].status, 'open');
  assert.equal(s.orders()[0].filled, 243.4);
  assert.equal(s.orders()[0].entry, 221);
  assert.equal(s.orders()[1].status, 'draft');
  assert.equal(s.orders()[1].entry, 228);
  advancePaperGrid(s, boardFor(243.4, low));
  advancePaperGrid(s, boardFor(243.4, low));
  assert.equal(s.orders().filter(order => order.status === 'open').length, 3);
  assert.ok(s.orders().every(order => order.status !== 'closed'));
  assert.equal(s.orders()[0].entry, 221);
  assert.equal(s.orders()[1].entry, 228);
  assert.equal(s.orders()[2].entry, 235);
  assert.ok(s.orders()[0].stop < 243.4);
});

test('short gap fill keeps planned entry so grid gaps stay intact', () => {
  const s = new Strategy({quantity: 1, maxLoss: 1e9, maxProfit: 1e9, trailStep: 8, trailStartLeg: 3});
  s.mode = 'paper';
  s.status = 'running';
  s.tradeMode = 'existing';
  s.inSession = () => true;
  const shortGrid = [
    {level: 1, entry: 180, target: 168, stop: 200},
    {level: 2, entry: 173, target: 161, stop: 193},
    {level: 3, entry: 166, target: 154, stop: 186}
  ];
  const board = price => boardFor(price, shortGrid, {side: 'short'});
  board(175.25).sides[0].side = 'short';
  const b = board(175.25);
  b.side = 'short';
  b.sides[0].side = 'short';
  advancePaperGrid(s, b);
  assert.equal(s.orders()[0].status, 'open');
  assert.equal(s.orders()[0].filled, 175.25);
  assert.equal(s.orders()[0].entry, 180);
  assert.equal(s.orders()[1].entry, 173);
  assert.equal(s.orders()[1].status, 'draft');
});

test('paper start after kill reseeds a new grid', () => {
  const s = new Strategy({quantity: 1, maxLoss: 500, maxProfit: 200});
  s.start('buy', 'paper', {scripCode: '1', label: 'NIFTY', optionType: 'CE'}, 'existing');
  s.inSession = () => true;
  advancePaperGrid(s, boardFor(100, grid, {lotSize: 65}));
  assert.equal(s.orders()[0].status, 'open');
  s.markOptionPrice(110, 'CE');
  assert.equal(s.status, 'killed');
  s.start('buy', 'paper', {scripCode: '1', label: 'NIFTY', optionType: 'CE'}, 'existing');
  assert.equal(s.status, 'running');
  assert.equal(s.realized, 0);
  assert.equal(s.orders().length, 0);
  advancePaperGrid(s, boardFor(100, grid, {lotSize: 65}));
  assert.ok(s.orders().some(order => order.status === 'open' || order.status === 'pending' || order.status === 'draft'));
  assert.equal(s.status, 'running');
});
