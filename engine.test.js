import test from 'node:test';
import assert from 'node:assert/strict';
import {Strategy, sessionSignal} from './engine.js';

function seed(s,side='buy') {
  s.arm(side);
  const start=Date.parse(`${s.day}T04:00:00Z`);
  for(let i=0;i<5;i++)s.candle({time:new Date(start+i*900000).toISOString(),open:100,high:101,low:99,close:100});
  s.candle({time:new Date(start+5*900000).toISOString(),open:100,high:104,low:99,close:103});
}
test('long signal, grid, no re-entry',()=>{
  const s=new Strategy();seed(s);
  assert.equal(s.pending.price,106);
  s.tick(106);assert.equal(s.level,1);
  s.tick(113);assert.equal(s.level,2);
  s.tick(120);assert.equal(s.level,3);
  assert.equal(s.sharedStop,106);
  s.tick(128);assert.equal(s.sharedStop,114);
  s.tick(105);assert.equal(s.status,'halted');
  assert.equal(s.legs.length,0);
  assert.throws(()=>s.arm('buy'),/re-entry/);
});
test('short signal and daily risk limit',()=>{
  const s=new Strategy({quantity:100,maxLoss:500});s.arm('short');
  const start=Date.parse(`${s.day}T04:00:00Z`);
  for(let i=0;i<5;i++)s.candle({time:new Date(start+i*900000).toISOString(),open:100,high:101,low:99,close:100});
  s.candle({time:new Date(start+5*900000).toISOString(),open:100,high:101,low:96,close:97});
  assert.equal(s.pending.price,94);
  s.tick(94);s.tick(100);
  assert.equal(s.status,'killed');assert.equal(s.legs.length,0);
});
test('pause cancels pending signal',()=>{const s=new Strategy();seed(s);s.pause();assert.equal(s.pending,null);s.resume();s.tick(120);assert.equal(s.level,0)});
test('option grid orders can be edited, placed, and removed',()=>{
  const s=new Strategy({quantity:2,gridStep:7,targetPoints:12,initialStop:20});
  const rows=[{level:1,side:'buy',entry:87.15,target:99.15,stop:67.15,quantity:2},{level:2,side:'buy',entry:94.15,target:106.15,stop:74.15,quantity:2}];
  s.optionOrder({action:'place',level:2,rows});
  assert.equal(s.optionOrders[1].status,'pending');
  s.optionOrder({action:'edit',id:s.optionOrders[1].id,entry:95,target:107,stop:75,quantity:3});
  assert.equal(s.optionOrders[1].entry,95);
  assert.equal(s.optionOrders[1].quantity,3);
  s.markOptionPrice(94);
  assert.equal(s.optionOrders[1].status,'pending');
  s.markOptionPrice(95);
  assert.equal(s.optionOrders[1].status,'open');
  assert.throws(()=>s.optionOrder({action:'remove',id:s.optionOrders[1].id}),/open order/);
  s.optionOrder({action:'place',id:s.optionOrders[0].id});
  assert.equal(s.optionOrders[0].status,'pending');
  s.optionOrders[0].brokerOrderId='209498391';
  s.optionOrder({action:'unplace',id:s.optionOrders[0].id});
  assert.equal(s.optionOrders[0].status,'draft');
  s.optionOrder({action:'place',id:s.optionOrders[0].id});
  assert.equal(s.optionOrders[0].brokerOrderId,'');
  assert.equal(s.optionOrders[0].status,'pending');
  s.optionOrder({action:'unplace',id:s.optionOrders[0].id});
  assert.equal(s.optionOrders[0].status,'draft');
  assert.throws(()=>s.optionOrder({action:'unplace',id:s.optionOrders[0].id}),/placed pending/);
  s.optionOrder({action:'add',side:'buy'});
  assert.equal(s.optionOrders.length,3);
  s.optionOrder({action:'remove',id:s.optionOrders[0].id});
  assert.equal(s.optionOrders.length,2);
});
test('a live order stays pending when the premium crosses its entry',()=>{
  const s=new Strategy();
  s.optionOrder({action:'place',level:1,live:true,rows:[{level:1,side:'buy',entry:79.95,target:91.95,stop:59.95,quantity:1}]});
  s.markOptionPrice(85.05);
  assert.equal(s.optionOrders[0].status,'pending');
  assert.equal(s.optionOrders[0].routing,'live');
});
test('entries stay inside the strategy start and end time',()=>{
  const s=new Strategy({strategyStart:'09:20',strategyEnd:'15:10'});
  s.arm('buy');
  const late=Date.parse(`${s.day}T10:30:00Z`);
  for(let i=0;i<6;i++)s.candle({time:new Date(late+i*900000).toISOString(),open:100,high:104,low:99,close:103});
  assert.equal(s.pending,null);
  assert.throws(()=>s.configure({strategyStart:'15:30',strategyEnd:'09:15'}),/after the start/);
});
test('existing mode keeps the current contract across a new day',()=>{
  const s=new Strategy();
  s.start('short','paper',{label:'NIFTY 22650 PE',scripCode:'1',strike:22650,optionType:'PE'},'existing');
  assert.equal(s.tradeMode,'existing');
  assert.equal(s.option.strike,22650);
  const next=Date.parse(`${s.day}T18:35:00Z`);
  s.candle({time:new Date(next).toISOString(),open:100,high:101,low:99,close:100});
  assert.equal(s.status,'running');
  assert.equal(s.option.strike,22650);
});
test('live mode waits for a signal that forms after start',()=>{
  const s=new Strategy();
  s.start('short','paper',null,'live');
  assert.equal(s.option,null);
  assert.equal(s.signal,null);
  const start=Math.floor(Date.parse('2026-10-07T09:15:00+05:30')/1000);
  const candles=[];
  for(let i=0;i<6;i++)candles.push({time:start+i*900,open:100,high:101,low:99,close:100,smaClose:100,smaOpen:100});
  candles.push({time:start+6*900,open:100,high:101,low:96,close:97,smaClose:100,smaOpen:100});
  candles.push({time:start+7*900,open:97,high:98,low:95,close:96,smaClose:99,smaOpen:99});
  assert.equal(sessionSignal(candles,{direction:'short',after:(start+8*900)*1000}),null);
  const found=sessionSignal(candles,{direction:'short',after:start*1000});
  assert.equal(found.spot,96);
  assert.equal(found.side,'short');
});
test('start and stop stay available after a kill',()=>{
  const s=new Strategy();
  s.start('buy');
  assert.equal(s.status,'running');
  s.stop();
  assert.equal(s.status,'paused');
  s.start('buy');
  assert.equal(s.status,'running');
  s.kill();
  assert.equal(s.status,'killed');
  s.start('short');
  assert.equal(s.status,'running');
  assert.equal(s.direction,'short');
});
